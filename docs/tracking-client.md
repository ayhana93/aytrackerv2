# Tracking client

How a route gets recorded on the device, what happens when the screen goes off, and what it takes
to make "records with the display off on a locked phone" actually true.

The server side of tracking is in [tracking.md](./tracking.md). This document is only about the
half that runs on the driver's phone: `packages/tracking-client`.

---

## 1. The honest answer about a locked screen

**A web PWA cannot record GPS while the display is off or the device is locked.** There is no API,
no service-worker trick and no manifest flag that changes this. The relevant platform facts:

| Platform                               | What happens when the screen locks                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS Safari, including an installed PWA | JavaScript is suspended within seconds. `watchPosition` stops firing. Web content has no background-location permission at all.                                                               |
| Android Chrome                         | Timers and geolocation are throttled hard when backgrounded; the tab is frozen and eventually discarded. An installed PWA survives longer but is still not permitted to collect indefinitely. |
| Periodic Background Sync               | Chrome only, requires installation, minimum interval around twelve hours. Useless for a trip.                                                                                                 |
| Background Sync (one-shot)             | Fires on reconnect. Useful for _flushing_ a queue, not for _collecting_ points.                                                                                                               |

So there are exactly two ways to keep recording while the phone is in a pocket:

1. **Screen Wake Lock** — keep the display on for the duration of the trip. Available in the
   browser today. The screen stays lit and the battery drains faster, but nothing is lost.
2. **A native wrapper** — Capacitor with a background-location plugin, an Android foreground
   service and iOS "Always" authorization. This is the only route to true background collection,
   and section 5 is its full configuration.

`detectCapabilities()` reports which of these the current device has, and the driver portal states
it plainly before the trip starts. This is deliberate. A driver who believes their route is being
recorded and discovers at the end of the week that it was not is worse off than one who was told
up front — and the gap will surface as a dispute about their pay, which is the worst possible place
to discover a platform limitation.

Whatever the device can do, the server treats silence the same way: a period without points becomes
a tracking gap, reported neutrally as "app no longer reporting". **A gap is never presented as a
driver having intentionally disabled tracking**, because a tunnel, a dead battery, a lost signal
and a deliberate force-quit are indistinguishable from the outside. See
[tracking.md §5](./tracking.md).

---

## 2. Shape of the package

```
LocationCollector            the port the driver portal is written against
   ├── WebLocationCollector      watchPosition + wake lock + IndexedDB queue
   └── NativeLocationCollector   the injected native bridge + the same queue

createLocationCollector()    picks one; native when a bridge is present
detectCapabilities()         what this device can do, for the UI to state
PointQueue                   IndexedDB, with an in-memory fallback
decideSampling()             re-exported from @aytracker/tracking
```

The portal imports `createLocationCollector` and never branches on platform. Everything
platform-specific is behind the port, which is what lets the same driver screen ship as a web app
today and inside a native shell later without a rewrite.

```ts
import { createLocationCollector } from '@aytracker/tracking-client';

const collector = createLocationCollector({
  tripId,
  minIntervalSeconds: 15,
  minDistanceMeters: 25,
  upload: (points) => postLocationBatch(tripId, points),
  onStatusChange: (status) => setStatus(status),
});

await collector.start();
// ... on trip end
await collector.stop();
```

---

## 3. Rules the client half obeys

**Queue before upload, always.** Every accepted fix is written to IndexedDB before the network is
touched. A failed request, a killed tab or a flat battery then costs nothing — the points are still
there on next launch. Uploading first and queuing on failure loses the points that were in flight
when the process died, which is exactly the moment they matter.

**The queue drops the oldest point on overflow.** The cap is 5,000 points per trip. When it is
reached the oldest points go, not the newest. Recent movement is what the server still needs to
close the trip correctly and to decide the tracking state; the beginning of a very long trip has
usually already been uploaded.

**Sampling is the same rule on both sides.** `decideSampling` comes from `@aytracker/tracking`, the
package the server uses. If the device applied its own thresholds the server's distance and the
device's would drift apart, and the only way to find out would be a driver disputing a figure.

**Never collect without an active tracking session.** The collector is constructed with a `tripId`
and refuses to run without one. There is no ambient background collection in this product — the
driver starts a trip and location flows; the trip ends and it stops.

**The client never computes a total.** Points go up; distance, duration and fuel come back down.
`packages/tracking/src/geo.ts` on the server is the only place a distance is calculated. The
figures the driver screen shows are the server's.

**Status reflects observable facts.** `CollectorStatus` reports the last fix, the last accuracy,
the queue depth, the dropped count, whether the screen is being held awake, and the permission
state. It never reports an inference about intent.

---

## 4. What happens on the web today

`WebLocationCollector` handles the whole visible lifecycle:

- `watchPosition` at high accuracy with `maximumAge: 0`, so a cached fix from before the trip never
  enters the track.
- A Screen Wake Lock while the trip is active, re-acquired on `visibilitychange` because the
  browser releases it whenever the page is hidden.
- `visibilitychange` → flush immediately and mark the moment collection stopped. The gap that
  follows is then anchored to a known time rather than reconstructed later.
- `online` → flush. `pagehide` → flush. Both are best-effort; the queue is the real guarantee.
- `flush()` is re-entrancy guarded, so a visibility change during an upload cannot send a batch
  twice.

Combined with the server's `client_action_id` idempotency, a batch that is uploaded twice because
the network lied about failing is stored once.

---

## 5. Native configuration — the part that makes screen-off recording real

The bridge the native collector expects, injected on `window` as `AYtrackerNative`:

```ts
interface NativeTrackingBridge {
  readonly version: string;
  start(options: {
    tripId: string;
    minIntervalSeconds: number;
    minDistanceMeters: number;
  }): Promise<void>;
  stop(): Promise<void>;
  /** Points the OS buffered while the web view was not running. */
  drain(): Promise<readonly NativePoint[]>;
  requestAlwaysAuthorization(): Promise<'granted' | 'denied' | 'restricted'>;
}
```

`drain()` is the important one. The OS keeps delivering fixes to the native layer while the web
view is suspended; the collector polls the buffer every fifteen seconds when it is alive, and
drains it on start and stop. Those points enter the same IndexedDB queue as live fixes and are
uploaded identically.

### Capacitor

```bash
pnpm add @capacitor/core @capacitor/cli
pnpm add @capacitor-community/background-geolocation
npx cap init AYtracker com.aytracker.app
npx cap add ios
npx cap add android
```

`capacitor.config.ts`:

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.aytracker.app',
  appName: 'AYtracker',
  webDir: 'apps/web/out',
  plugins: {
    BackgroundGeolocation: {
      // The notification text is shown for as long as tracking runs. It is the platform
      // enforcing the same promise this product makes independently.
      backgroundMessage: 'AYtracker записва маршрута ви',
      backgroundTitle: 'Активен курс',
      requestPermissions: true,
      stale: false,
      distanceFilter: 25,
    },
  },
};

export default config;
```

### iOS

`ios/App/App/Info.plist`:

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>AYtracker записва маршрута ви, докато сте на курс.</string>

<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>AYtracker записва маршрута ви по време на смяната, включително при изгасен екран. Записът спира, когато приключите курса.</string>

<key>UIBackgroundModes</key>
<array>
  <string>location</string>
  <string>fetch</string>
</array>
```

Requirements that are easy to get wrong:

- **The purpose strings must be in the driver's language and must be specific.** App Review
  rejects vague ones, and a driver reading a generic string has not really consented.
- **Ask in-app before triggering the system prompt.** The driver portal explains why "Always" is
  needed and only then calls `requestAlwaysAuthorization()`. iOS shows the system dialog once; a
  driver who declines it because it arrived without context cannot be asked again from inside the
  app.
- **iOS may downgrade "Always" to "While Using" on its own** after a period, and shows the driver a
  reminder with a map of collected locations. Handle a downgrade as a capability change: report it
  in `CollectorStatus.permission` and let the portal say the recording is now foreground-only.
- **`stop()` must actually stop the location manager.** Tracking that outlives the trip is both a
  privacy violation and a rejection.

### Android

`android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
<uses-permission android:name="android.permission.WAKE_LOCK" />

<service
    android:name="com.equimaps.capacitor_background_geolocation.BackgroundGeolocationService"
    android:foregroundServiceType="location"
    android:enabled="true"
    android:exported="false" />
```

Requirements that are easy to get wrong:

- **`ACCESS_BACKGROUND_LOCATION` must be requested separately, and only after foreground location
  has been granted.** Requesting both at once fails on Android 11+. On Android 11 and later the
  system sends the user to Settings rather than showing a dialog, so the portal has to explain
  where they are going before it opens it.
- **A foreground service with a persistent notification is mandatory.** Do not try to hide or
  minimise the notification. It is the platform telling the driver they are being tracked, which is
  the same thing this product commits to.
- **Battery optimisation kills background services.** Some OEM builds (Xiaomi, Huawei, Oppo,
  Samsung) are far more aggressive than stock Android. Detect it and ask the driver once to exempt
  AYtracker; if they decline, that is their call — record the resulting silence as a gap like any
  other.
- **Play Console requires a background-location declaration** with a video demonstrating the
  in-app disclosure and the runtime prompt. Budget review time for it.

### Play Store and App Store disclosure

Both stores require a prominent in-app disclosure _before_ the runtime permission request,
explaining what is collected, why, and that it continues in the background. The driver portal shows
it as a full screen on first trip, not a line of small print, and the acceptance is recorded in the
audit log with a timestamp — because "the driver was told" is a claim the operator may one day have
to substantiate.

---

## 6. What the driver is told

The notice keys in `capabilities.ts` map to what the device can really do:

| Capability        | Message                                                                           |
| ----------------- | --------------------------------------------------------------------------------- |
| `NATIVE`          | Recording continues with the screen off.                                          |
| `WAKE_LOCK`       | Recording works while the screen is on. AYtracker keeps it awake during the trip. |
| `FOREGROUND_ONLY` | Keep AYtracker open to record the route. Interruptions are marked.                |
| `NONE`            | This device does not support location tracking.                                   |

Only `NATIVE` promises screen-off recording, and only a native build can return it. The strings are
message keys resolved through `@aytracker/localization` — never English literals from the
capability module, since the driver may not read English.

---

## 7. Testing

- **Unit** — sampling decisions, queue overflow order, status transitions. No browser needed.
- **Integration** — the upload path against a real API, including a duplicate batch to prove
  idempotency holds.
- **Manual, and unavoidable** — lock the phone mid-trip on each target platform and confirm the
  recorded track matches what the notice promised. This is the one claim that cannot be verified in
  CI, and it is also the one a driver will notice first.
