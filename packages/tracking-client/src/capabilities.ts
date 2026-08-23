/**
 * What this device can actually do about background tracking.
 *
 * ---------------------------------------------------------------------------
 * THE PLATFORM REALITY, STATED PLAINLY
 * ---------------------------------------------------------------------------
 *
 * **A web PWA cannot record GPS with the display off or the device locked.** Not with a
 * different API, not with a service worker, not with a trick. The relevant facts:
 *
 *   iOS Safari      JavaScript is suspended within seconds of the screen locking, including in
 *                   an installed PWA. `watchPosition` stops firing. There is no background
 *                   location permission available to web content.
 *
 *   Android Chrome  Timers and geolocation are throttled heavily when backgrounded and the tab
 *                   is frozen or discarded after a short period. An installed PWA fares better
 *                   but is still not permitted to collect location indefinitely.
 *
 *   Periodic
 *   Background Sync Chrome-only, requires installation, minimum interval around twelve hours.
 *                   Useless for a trip.
 *
 *   Background Sync One-shot, fires on reconnect. Useful for *flushing* the queue, not for
 *                   *collecting* points.
 *
 * So there are exactly two ways to record a trip while the phone is in a pocket:
 *
 *   1. **Screen Wake Lock** — keep the display on. Works, but the driver's screen stays lit and
 *      the battery drains. Honest, available today, and the right default for a short trip.
 *
 *   2. **A native wrapper** — Capacitor or similar, with a background-location plugin, an
 *      Android foreground service and iOS "Always" location authorization. This is the only way
 *      to get true background collection. See docs/tracking-client.md for the configuration.
 *
 * This module reports which of those is available so the interface can tell the driver the
 * truth rather than promising something the platform will not deliver. A driver who believes
 * their route is being recorded, and finds out at the end of the day that it was not, is worse
 * off than one who was told up front.
 *
 * Whatever happens, the server side is already honest about it: a period with no points becomes
 * a tracking gap, reported neutrally as "app no longer reporting" — never as an accusation.
 */

export type BackgroundCapability =
  /** Native background location. Records with the screen off. */
  | 'NATIVE'
  /** Web only. Records while the screen is on; a wake lock can keep it on. */
  | 'WAKE_LOCK'
  /** Web without wake lock support. Records only while the app is in the foreground. */
  | 'FOREGROUND_ONLY'
  /** No geolocation at all. */
  | 'NONE';

export interface TrackingCapabilities {
  readonly geolocation: boolean;
  readonly wakeLock: boolean;
  readonly permissionsApi: boolean;
  readonly native: boolean;
  readonly background: BackgroundCapability;
  /**
   * Message key for what to tell the driver about screen-off behaviour. Resolved by the
   * localization layer; never an English string from here.
   */
  readonly backgroundNoticeKey: string;
}

/** The bridge a native wrapper injects. Absent in a plain browser. */
export interface NativeTrackingBridge {
  readonly version: string;
  start(options: {
    /** The tracking session, which may be a working day or a trip. */
    sessionId: string;
    minIntervalSeconds: number;
    minDistanceMeters: number;
  }): Promise<void>;
  stop(): Promise<void>;
  /** Points buffered by the OS while the app was not running. */
  drain(): Promise<
    readonly {
      timestamp: number;
      latitude: number;
      longitude: number;
      accuracy?: number;
      speed?: number;
      heading?: number;
      altitude?: number;
    }[]
  >;
  requestAlwaysAuthorization(): Promise<'granted' | 'denied' | 'restricted'>;
}

declare global {
  interface Window {
    AYtrackerNative?: NativeTrackingBridge;
  }
}

export function detectCapabilities(): TrackingCapabilities {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {
      geolocation: false,
      wakeLock: false,
      permissionsApi: false,
      native: false,
      background: 'NONE',
      backgroundNoticeKey: 'tracking.background.unavailable',
    };
  }

  const native = typeof window.AYtrackerNative?.start === 'function';
  const geolocation = 'geolocation' in navigator;
  const wakeLock = 'wakeLock' in navigator;
  const permissionsApi = 'permissions' in navigator;

  const background: BackgroundCapability = !geolocation
    ? 'NONE'
    : native
      ? 'NATIVE'
      : wakeLock
        ? 'WAKE_LOCK'
        : 'FOREGROUND_ONLY';

  return {
    geolocation,
    wakeLock,
    permissionsApi,
    native,
    background,
    backgroundNoticeKey: BACKGROUND_NOTICE_KEYS[background],
  };
}

const BACKGROUND_NOTICE_KEYS: Readonly<Record<BackgroundCapability, string>> = {
  // "Recording continues with the screen off."
  NATIVE: 'tracking.background.native',
  // "Keep the screen on to record the whole route. AYtracker will keep it awake."
  WAKE_LOCK: 'tracking.background.wake_lock',
  // "Keep AYtracker open to record the route. Gaps will be shown on the trip."
  FOREGROUND_ONLY: 'tracking.background.foreground_only',
  NONE: 'tracking.background.unavailable',
};

export async function checkLocationPermission(): Promise<
  'granted' | 'denied' | 'prompt' | 'unknown'
> {
  if (typeof navigator === 'undefined' || !('permissions' in navigator)) return 'unknown';
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    return status.state;
  } catch {
    // Safari has historically not supported querying geolocation. Not knowing is a valid answer;
    // the caller falls back to asking.
    return 'unknown';
  }
}
