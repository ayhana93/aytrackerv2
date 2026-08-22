import { decideSampling, type GeoPointLike } from './sampling-bridge';
import { createPointQueue, type PointQueue, type QueuedPoint } from './queue';
import { checkLocationPermission, detectCapabilities } from './capabilities';
import type { CollectorOptions, CollectorStatus, LocationCollector, RawPoint } from './types';

/**
 * Browser location collection.
 *
 * Does everything the web platform actually permits, and is honest about the rest:
 *
 *   * `watchPosition` with high accuracy, filtered through the shared adaptive-sampling rule so
 *     the device and the server agree on what is worth sending.
 *   * Every accepted point is queued to IndexedDB *before* the upload is attempted, so a failed
 *     request, a killed tab or a dead battery costs nothing.
 *   * An optional Screen Wake Lock, because keeping the display on is the only way a browser
 *     can keep collecting when the phone is in a pocket.
 *   * Visibility and freeze handling, so the moment collection stops is recorded rather than
 *     guessed at afterwards.
 *
 * What it does **not** do is pretend to work with the screen off. When the page is hidden the
 * browser stops delivering fixes; this class notices, flushes what it has, and reports
 * `INTERRUPTED`. The server turns the resulting silence into a visible tracking gap — the same
 * neutral treatment a tunnel gets, because from the outside they are indistinguishable.
 */
export class WebLocationCollector implements LocationCollector {
  private watchId: number | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private queue: PointQueue = createPointQueue();
  private seq = Date.now();
  private uploading = false;
  private lastSentAt: Date | null = null;
  private lastSentPoint: GeoPointLike | null = null;

  private current: CollectorStatus = {
    state: 'STOPPED',
    lastFixAt: null,
    lastAccuracyMeters: null,
    queuedPoints: 0,
    screenHeldAwake: false,
    permission: 'unknown',
    droppedPoints: 0,
  };

  constructor(private readonly options: CollectorOptions) {}

  status(): CollectorStatus {
    return this.current;
  }

  async start(): Promise<void> {
    const capabilities = detectCapabilities();
    if (!capabilities.geolocation) {
      this.update({ state: 'INTERRUPTED', permission: 'denied' });
      return;
    }

    this.update({ permission: await checkLocationPermission() });

    this.watchId = navigator.geolocation.watchPosition(
      (position) => void this.onFix(position),
      (error) => this.onError(error),
      {
        enableHighAccuracy: true,
        // Never serve a cached fix: a stale position on a moving vehicle is worse than none.
        maximumAge: 0,
        timeout: 30_000,
      },
    );

    if (this.options.holdScreenAwake) {
      await this.acquireWakeLock();
    }

    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('online', this.onOnline);
    // `pagehide` fires where `beforeunload` does not on iOS. Last chance to flush.
    window.addEventListener('pagehide', this.onPageHide);

    this.update({ state: 'ACTIVE' });
  }

  async stop(): Promise<void> {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('pagehide', this.onPageHide);

    await this.releaseWakeLock();
    await this.flush();
    await this.queue.clear(this.options.sessionId);
    this.update({ state: 'STOPPED', screenHeldAwake: false });
  }

  /**
   * Drains the queue in batches.
   *
   * Points are removed only after the server accepts them, so a failure mid-flush leaves the
   * queue intact and the next attempt resends. Guarded against re-entry: a flush triggered by
   * reconnect while another is already running would send the same points twice.
   */
  async flush(): Promise<void> {
    if (this.uploading) return;
    this.uploading = true;
    try {
      for (;;) {
        const batch = await this.queue.peek(200);
        if (batch.length === 0) break;
        await this.options.upload(batch.map(toRawPoint));
        await this.queue.remove(batch.map((point) => point.seq));
      }
      this.update({ queuedPoints: await this.queue.size() });
    } catch {
      // Offline, or the server refused. The points stay queued; the next reconnect retries.
      this.update({ state: 'OFFLINE', queuedPoints: await this.queue.size() });
    } finally {
      this.uploading = false;
    }
  }

  private async onFix(position: GeolocationPosition): Promise<void> {
    const now = new Date(position.timestamp);
    const point: GeoPointLike = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    };

    // The same rule the server enforces as a floor. Applying it here keeps the device from
    // spending battery and bandwidth on points the server would drop anyway.
    const decision = decideSampling({
      lastSentAt: this.lastSentAt,
      lastSentPoint: this.lastSentPoint,
      current: point,
      currentSpeedMps: position.coords.speed,
      batteryLevel: null,
      now,
      minIntervalSeconds: this.options.minIntervalSeconds,
      minDistanceMeters: this.options.minDistanceMeters,
    });

    this.update({
      lastFixAt: now,
      lastAccuracyMeters: position.coords.accuracy,
      state: document.visibilityState === 'visible' ? 'ACTIVE' : 'DEGRADED',
    });

    if (!decision.shouldSend) return;

    this.seq += 1;
    const queued: QueuedPoint = {
      sessionId: this.options.sessionId,
      seq: this.seq,
      timestamp: position.timestamp,
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyMeters: position.coords.accuracy ?? null,
      speedMps: position.coords.speed,
      heading: position.coords.heading,
      altitude: position.coords.altitude,
      source: 'GPS',
    };

    const { dropped } = await this.queue.enqueue([queued]);
    this.lastSentAt = now;
    this.lastSentPoint = point;
    this.update({
      queuedPoints: await this.queue.size(),
      droppedPoints: this.current.droppedPoints + dropped,
    });

    void this.flush();
  }

  private onError(error: GeolocationPositionError): void {
    // PERMISSION_DENIED is the only one that is definitely about the user's choice. The others
    // are about the world — a tunnel, a cold GPS chip, a timeout — so neither the state nor the
    // event says anything about intent.
    this.update({
      state: 'INTERRUPTED',
      permission: error.code === error.PERMISSION_DENIED ? 'denied' : this.current.permission,
    });
  }

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      // The browser is about to stop delivering fixes. Get what we have to the server while
      // there is still a chance, and report the state honestly.
      void this.flush();
      this.update({ state: 'DEGRADED' });
    } else {
      this.update({ state: 'ACTIVE' });
      // A wake lock is released automatically when the page is hidden and must be re-acquired.
      if (this.options.holdScreenAwake) void this.acquireWakeLock();
      void this.flush();
    }
  };

  private readonly onOnline = (): void => {
    void this.flush();
  };

  private readonly onPageHide = (): void => {
    void this.flush();
  };

  private async acquireWakeLock(): Promise<void> {
    if (!('wakeLock' in navigator)) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => {
        this.update({ screenHeldAwake: false });
      });
      this.update({ screenHeldAwake: true });
    } catch {
      // Denied, or the battery saver refused. Not fatal — the driver was already told that
      // recording needs the screen on.
      this.update({ screenHeldAwake: false });
    }
  }

  private async releaseWakeLock(): Promise<void> {
    try {
      await this.wakeLock?.release();
    } catch {
      // Already released.
    }
    this.wakeLock = null;
  }

  private update(patch: Partial<CollectorStatus>): void {
    this.current = { ...this.current, ...patch };
    this.options.onStatusChange?.(this.current);
  }
}

function toRawPoint(point: QueuedPoint): RawPoint {
  return {
    timestamp: point.timestamp,
    latitude: point.latitude,
    longitude: point.longitude,
    accuracyMeters: point.accuracyMeters,
    speedMps: point.speedMps,
    heading: point.heading,
    altitude: point.altitude,
    source: point.source,
  };
}
