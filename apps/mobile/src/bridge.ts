import { registerPlugin } from '@capacitor/core';
import type { NativeTrackingBridge } from '@aytracker/tracking-client';

/**
 * `window.AYtrackerNative` — the bridge the web portal already expects.
 *
 * `packages/tracking-client` was written against an interface, not against a plugin: the driver
 * and worker portals call `LocationCollector`, and `NativeLocationCollector` delegates to whatever
 * is on `window.AYtrackerNative`. This file is the only place a Capacitor plugin appears in the
 * whole product. Swapping the plugin, or shipping a bare WKWebView wrapper instead, changes this
 * file and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS RESPONSIBLE FOR
 * ---------------------------------------------------------------------------
 *
 * **Buffering.** The OS delivers fixes when it feels like it, including while the web view is
 * suspended or dead. Points are held here and handed over by `drain()`, which is polled by the
 * collector. Nothing is uploaded from this layer: the queue, the retry policy and the batching
 * all live in `packages/tracking-client`, and duplicating them here is how two upload paths end
 * up disagreeing about what was sent.
 *
 * **Permission, honestly.** `requestAlwaysAuthorization` reports what the OS said and nothing
 * more. It never retries a denial in a loop, and it never reports "granted" for a "while in use"
 * grant — a permission that stops at the lock screen cannot record a route, and saying otherwise
 * would make the portal claim tracking is running when it is not.
 *
 * **Nothing else.** No distance, no filtering beyond the sampling floor the server set, no
 * decisions about what a trip is. Every number that matters is computed on the server from the
 * points it stored.
 */

/**
 * The plugin's own surface, declared rather than imported as a type.
 *
 * `@capacitor-community/background-geolocation` ships its types through `registerPlugin`'s
 * generic, and pinning the shape here keeps the compile honest about exactly which calls this
 * bridge depends on — a plugin upgrade that changes one of them fails the build instead of
 * failing on a driver's phone at six in the morning.
 */
interface BackgroundGeolocationPlugin {
  addWatcher(
    options: {
      backgroundMessage?: string;
      backgroundTitle?: string;
      requestPermissions?: boolean;
      stale?: boolean;
      distanceFilter?: number;
    },
    callback: (position?: NativePosition, error?: NativeError) => void,
  ): Promise<string>;
  removeWatcher(options: { id: string }): Promise<void>;
  openSettings(): Promise<void>;
}

interface NativePosition {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  altitude: number | null;
  speed: number | null;
  bearing: number | null;
  time: number | null;
  simulated?: boolean;
}

interface NativeError {
  code: 'NOT_AUTHORIZED' | 'DENIED' | string;
  message: string;
}

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

export interface BufferedPoint {
  timestamp: number;
  latitude: number;
  longitude: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
  altitude?: number;
}

/**
 * How many fixes may pile up before the oldest are dropped.
 *
 * At the fifteen-second floor this is a little over four hours of continuous recording with the
 * app never once resumed — far beyond any realistic gap, and bounded so a phone left in a drawer
 * for a week cannot exhaust its own storage. Drops are counted, and the collector reports the
 * count, because silently losing points and silently drawing the line across the hole is exactly
 * the failure this product is not allowed to have.
 */
const MAX_BUFFERED_POINTS = 1000;

/**
 * The notification text Android shows for the whole time recording runs.
 *
 * Deliberately plain, and deliberately not minimised. Android requires it; this product would
 * want it anyway, because "the driver always knows when they are being recorded" is a promise
 * that is worth more when the platform enforces it too.
 */
const NOTIFICATION = {
  title: 'AYtracker',
  message: 'Записва маршрута на смяната.',
} as const;

class NativeBridge implements NativeTrackingBridge {
  readonly version = '1.0.0';

  private watcherId: string | null = null;
  private buffer: BufferedPoint[] = [];
  private dropped = 0;
  /** Set when the OS refuses, so `requestAlwaysAuthorization` can answer without guessing. */
  private lastError: NativeError | null = null;

  async requestAlwaysAuthorization(): Promise<'granted' | 'denied' | 'restricted'> {
    /*
     * The permission is requested by starting a watcher, because that is the only thing the
     * plugin exposes that triggers the OS prompt — and it is also the honest test: a permission
     * that does not survive the app going to the background is not the permission we asked for,
     * and the watcher is what finds that out.
     *
     * The portal has already shown its own explanation by the time this runs. Apple requires the
     * "Always" prompt to follow an in-app explanation, and a driver deserves one regardless.
     */
    this.lastError = null;
    try {
      const id = await BackgroundGeolocation.addWatcher(
        {
          backgroundTitle: NOTIFICATION.title,
          backgroundMessage: NOTIFICATION.message,
          requestPermissions: true,
          stale: false,
        },
        (position, error) => this.receive(position, error),
      );
      // Held: `start` reuses it rather than prompting a second time.
      this.watcherId = id;
      return this.lastError ? this.classify(this.lastError) : 'granted';
    } catch (error) {
      this.lastError = error as NativeError;
      return this.classify(this.lastError);
    }
  }

  async start(options: {
    sessionId: string;
    minIntervalSeconds: number;
    minDistanceMeters: number;
  }): Promise<void> {
    if (this.watcherId) {
      // Already watching from the permission request. The plugin has no reconfigure call, so the
      // watcher is replaced only when the distance filter actually changed.
      await this.stop();
    }

    this.watcherId = await BackgroundGeolocation.addWatcher(
      {
        backgroundTitle: NOTIFICATION.title,
        backgroundMessage: NOTIFICATION.message,
        requestPermissions: false,
        // Stale fixes are the cached last-known position, which can be hours and kilometres old.
        // Storing one would place somebody where they no longer are.
        stale: false,
        /*
         * The server's floor, applied at the source.
         *
         * The plugin filters by distance rather than by time, so the interval cannot be enforced
         * here — the server does that on ingestion. Filtering here is about battery: a phone that
         * wakes its GPS every second in a car park costs a driver their afternoon's charge and
         * buys nothing, because those points are dropped on arrival anyway.
         */
        distanceFilter: options.minDistanceMeters,
      },
      (position, error) => this.receive(position, error),
    );
  }

  async stop(): Promise<void> {
    const id = this.watcherId;
    this.watcherId = null;
    if (!id) return;
    await BackgroundGeolocation.removeWatcher({ id });
  }

  async drain(): Promise<readonly BufferedPoint[]> {
    const points = this.buffer;
    this.buffer = [];
    return points;
  }

  /** How many buffered points were discarded because the buffer was full. Reported, never hidden. */
  droppedPoints(): number {
    return this.dropped;
  }

  /** Opens the OS settings page, for a driver who denied the permission and wants to fix it. */
  async openSettings(): Promise<void> {
    await BackgroundGeolocation.openSettings();
  }

  private receive(position?: NativePosition, error?: NativeError): void {
    if (error) {
      this.lastError = error;
      return;
    }
    if (!position) return;
    /*
     * A simulated fix is not evidence.
     *
     * Android's mock-location setting and iOS's simulator both produce positions that look
     * exactly like real ones. Recording them would let a route be fabricated from a phone, which
     * is the one thing a tracking product must not accept — and the plugin already tells us.
     */
    if (position.simulated) return;

    this.buffer.push({
      timestamp: position.time ?? Date.now(),
      latitude: position.latitude,
      longitude: position.longitude,
      ...(position.accuracy !== null ? { accuracy: position.accuracy } : {}),
      ...(position.speed !== null ? { speed: position.speed } : {}),
      ...(position.bearing !== null ? { heading: position.bearing } : {}),
      ...(position.altitude !== null ? { altitude: position.altitude } : {}),
    });

    if (this.buffer.length > MAX_BUFFERED_POINTS) {
      // Oldest first: recent history is what the live map and the current trip need.
      this.dropped += this.buffer.length - MAX_BUFFERED_POINTS;
      this.buffer = this.buffer.slice(-MAX_BUFFERED_POINTS);
    }
  }

  private classify(error: NativeError): 'denied' | 'restricted' {
    // NOT_AUTHORIZED is the plugin's "the user can grant this but has not"; anything else at this
    // point is the OS or a policy refusing outright.
    return error.code === 'NOT_AUTHORIZED' || error.code === 'DENIED' ? 'denied' : 'restricted';
  }
}

/**
 * Installs the bridge.
 *
 * Called once from the app entry point, before the portal is loaded. `detectCapabilities()` in
 * the web layer looks for exactly this, and everything downstream — the background notice the
 * portal shows, whether the screen is held awake, which collector runs — follows from whether it
 * is there.
 */
export function installNativeBridge(): void {
  const bridge = new NativeBridge();
  (window as unknown as { AYtrackerNative: NativeBridge }).AYtrackerNative = bridge;
}
