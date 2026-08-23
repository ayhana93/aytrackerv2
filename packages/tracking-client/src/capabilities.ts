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
 * This product is web-based, so there is exactly one way to record while the phone is in a
 * pocket: **the Screen Wake Lock** — keep the display on. It works, the screen stays lit and the
 * battery drains faster. That is the honest trade, and the portal states it before a shift
 * starts rather than letting a driver discover it at the end of the day.
 *
 * Installing the app to the home screen does not change what the platform permits. It does make
 * the app survive being backgrounded longer on Android, and it gives a worker an icon to tap
 * instead of a URL to remember, which is why the portal offers it.
 *
 * There is deliberately no native-wrapper branch here. A code path that reports "recording
 * continues with the screen off" is a lie in a web product, and an unreachable one is worse than
 * none: it survives review because nobody runs it. If a native shell is ever built, this is a
 * new `BackgroundCapability` and a new collector — not a dormant branch kept warm for years.
 *
 * Whatever happens, the server side is already honest about it: a period with no points becomes
 * a tracking gap, reported neutrally as "app no longer reporting" — never as an accusation.
 */

export type BackgroundCapability =
  /** Records while the screen is on; a wake lock can keep it on. The normal case. */
  | 'WAKE_LOCK'
  /** Web without wake lock support. Records only while the app is in the foreground. */
  | 'FOREGROUND_ONLY'
  /** No geolocation at all. */
  | 'NONE';

export interface TrackingCapabilities {
  readonly geolocation: boolean;
  readonly wakeLock: boolean;
  readonly permissionsApi: boolean;
  /**
   * Whether the app is running from the home screen rather than a browser tab.
   *
   * It does not change what the platform permits — an installed PWA still cannot collect with
   * the screen off — but it changes how long the app survives being backgrounded on Android, and
   * it is the difference between an icon a worker taps and a URL they have to remember. Worth
   * knowing so the portal can suggest installing.
   */
  readonly installed: boolean;
  readonly background: BackgroundCapability;
  /**
   * Message key for what to tell the driver about screen-off behaviour. Resolved by the
   * localization layer; never an English string from here.
   */
  readonly backgroundNoticeKey: string;
}

export function detectCapabilities(): TrackingCapabilities {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {
      geolocation: false,
      wakeLock: false,
      permissionsApi: false,
      installed: false,
      background: 'NONE',
      backgroundNoticeKey: 'tracking.background.unavailable',
    };
  }

  const geolocation = 'geolocation' in navigator;
  const wakeLock = 'wakeLock' in navigator;
  const permissionsApi = 'permissions' in navigator;
  /*
   * `display-mode: standalone` covers Android and desktop; `navigator.standalone` is the iOS
   * equivalent and exists nowhere else, which is why it is read off a widened type rather than
   * added to the global Navigator.
   */
  const installed =
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;

  const background: BackgroundCapability = !geolocation
    ? 'NONE'
    : wakeLock
      ? 'WAKE_LOCK'
      : 'FOREGROUND_ONLY';

  return {
    geolocation,
    wakeLock,
    permissionsApi,
    installed,
    background,
    backgroundNoticeKey: BACKGROUND_NOTICE_KEYS[background],
  };
}

const BACKGROUND_NOTICE_KEYS: Readonly<Record<BackgroundCapability, string>> = {
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
