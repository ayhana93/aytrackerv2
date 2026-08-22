import { createPointQueue, type PointQueue } from './queue';
import type { CollectorOptions, CollectorStatus, LocationCollector, RawPoint } from './types';

/**
 * Native background collection.
 *
 * The only way to record a trip with the display off. It delegates to a bridge the native
 * wrapper injects on `window`, and exists here — rather than in the app — so the driver portal
 * is written against one `LocationCollector` interface and does not care which is underneath.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE WRAPPER MUST PROVIDE
 * ---------------------------------------------------------------------------
 *
 * Capacitor with `@capacitor-community/background-geolocation` (or an equivalent), plus:
 *
 *   **iOS** — `NSLocationAlwaysAndWhenInUseUsageDescription` explaining, in the driver's own
 *   language, that the app records routes during a shift. Background modes: `location`. Apple
 *   review requires the "Always" prompt to follow an in-app explanation, which is why the
 *   driver portal asks first and only then calls `requestAlwaysAuthorization`.
 *
 *   **Android** — `ACCESS_FINE_LOCATION` plus `ACCESS_BACKGROUND_LOCATION`, and a **foreground
 *   service** of type `location` with a persistent notification. The notification is not a
 *   nuisance to be minimised: it is the platform enforcing the same thing this product promises
 *   independently, which is that a driver always knows when they are being tracked.
 *
 * The bridge buffers points the OS delivered while the web view was not running; `drain()`
 * returns them and they enter the same queue as live fixes.
 *
 * Configuration and the full plugin setup are in docs/tracking-client.md.
 */
export class NativeLocationCollector implements LocationCollector {
  private queue: PointQueue = createPointQueue();
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private seq = Date.now();
  private uploading = false;

  private current: CollectorStatus = {
    state: 'STOPPED',
    lastFixAt: null,
    lastAccuracyMeters: null,
    queuedPoints: 0,
    // The native service does not need the screen, which is the whole point of it.
    screenHeldAwake: false,
    permission: 'unknown',
    droppedPoints: 0,
  };

  constructor(private readonly options: CollectorOptions) {}

  status(): CollectorStatus {
    return this.current;
  }

  async start(): Promise<void> {
    const bridge = window.AYtrackerNative;
    if (!bridge) {
      this.update({ state: 'INTERRUPTED' });
      return;
    }

    const authorization = await bridge.requestAlwaysAuthorization();
    this.update({ permission: authorization === 'granted' ? 'granted' : 'denied' });
    if (authorization !== 'granted') {
      // Recording without the permission the driver was asked for is not an option. The portal
      // falls back to the web collector and says so.
      this.update({ state: 'INTERRUPTED' });
      return;
    }

    await bridge.start({
      sessionId: this.options.sessionId,
      minIntervalSeconds: this.options.minIntervalSeconds,
      minDistanceMeters: this.options.minDistanceMeters,
    });

    // The OS delivers points on its own schedule; polling the buffer is how they reach the
    // queue when the web view happens to be alive.
    this.drainTimer = setInterval(() => void this.drain(), 15_000);
    this.update({ state: 'ACTIVE' });
    void this.drain();
  }

  async stop(): Promise<void> {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    await window.AYtrackerNative?.stop();
    await this.drain();
    await this.flush();
    await this.queue.clear(this.options.sessionId);
    this.update({ state: 'STOPPED' });
  }

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
      this.update({ state: 'OFFLINE', queuedPoints: await this.queue.size() });
    } finally {
      this.uploading = false;
    }
  }

  private async drain(): Promise<void> {
    const bridge = window.AYtrackerNative;
    if (!bridge) return;

    const points = await bridge.drain();
    if (points.length === 0) {
      await this.flush();
      return;
    }

    const queued = points.map((point) => {
      this.seq += 1;
      return {
        sessionId: this.options.sessionId,
        seq: this.seq,
        timestamp: point.timestamp,
        latitude: point.latitude,
        longitude: point.longitude,
        accuracyMeters: point.accuracy ?? null,
        speedMps: point.speed ?? null,
        heading: point.heading ?? null,
        altitude: point.altitude ?? null,
        source: 'GPS' as const,
      };
    });

    const { dropped } = await this.queue.enqueue(queued);
    const last = points.at(-1);
    this.update({
      lastFixAt: last ? new Date(last.timestamp) : this.current.lastFixAt,
      lastAccuracyMeters: last?.accuracy ?? this.current.lastAccuracyMeters,
      queuedPoints: await this.queue.size(),
      droppedPoints: this.current.droppedPoints + dropped,
      state: 'ACTIVE',
    });

    await this.flush();
  }

  private update(patch: Partial<CollectorStatus>): void {
    this.current = { ...this.current, ...patch };
    this.options.onStatusChange?.(this.current);
  }
}

function toRawPoint(point: {
  timestamp: number;
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  speedMps: number | null;
  heading: number | null;
  altitude: number | null;
  source: RawPoint['source'];
}): RawPoint {
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
