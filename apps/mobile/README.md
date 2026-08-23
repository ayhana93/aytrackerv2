# @aytracker/mobile

The native shell. It exists for one reason: a browser cannot record a route with the display off,
and most of a driving day happens with the display off.

There are no screens here. The app loads the deployed web portal and injects
`window.AYtrackerNative`, which is the bridge `packages/tracking-client` was written against. One
set of screens, one set of API calls, one place a bug gets fixed.

## What is verified, and what is not

**This has never been built or run on a device.** It was written in an environment with no Android
SDK, no Xcode and no CocoaPods, so `cap add android`, `cap add ios`, a Gradle build and an Xcode
build have all not been executed. Saying otherwise would be the exact failure this codebase is
written to avoid, so here is the honest split:

|                                                                         | State                                |
| ----------------------------------------------------------------------- | ------------------------------------ |
| `src/bridge.ts` compiles against the real plugin's API                  | ✅ verified by `pnpm typecheck`      |
| Bridge satisfies the `NativeTrackingBridge` contract the portal expects | ✅ verified by `pnpm typecheck`      |
| Permission, buffering and drop-counting logic                           | ⚠️ reviewed, not device-tested       |
| Android foreground service actually survives the screen locking         | ❌ **not verified** — needs a device |
| iOS background updates actually continue when suspended                 | ❌ **not verified** — needs a device |
| Battery cost over a real eight-hour shift                               | ❌ **not measured**                  |
| App Store / Play Store review outcome                                   | ❌ **not submitted**                 |

The three rows marked ❌ are the ones that decide whether this feature works at all, and none of
them can be answered from a CI container. Treat what is here as a correct and complete starting
point that a developer with a phone finishes in a day — not as a shipped mobile app.

## Bringing it up

```bash
export AY_PORTAL_URL=https://app.example.com   # no default: a wrong URL points a fleet elsewhere
pnpm --filter @aytracker/mobile build
pnpm --filter @aytracker/mobile cap:add:android    # needs the Android SDK
pnpm --filter @aytracker/mobile cap:add:ios        # needs Xcode and CocoaPods
```

Then apply the two override files by hand — they are not generated, and the generated projects are
not committed:

- `android-overrides/AndroidManifest.additions.xml` → `android/app/src/main/AndroidManifest.xml`
- `ios-overrides/Info.plist.additions.xml` → `ios/App/App/Info.plist`

Each file says why every line in it exists. The two that decide whether the product works are the
`FOREGROUND_SERVICE_LOCATION` permission plus the service's `android:foregroundServiceType`
(without both, Android 14 terminates the service the moment it starts) and iOS's `UIBackgroundModes`
= `location`.

Then `pnpm --filter @aytracker/mobile cap:sync` and open the platform project.

## The first thing to test on a real phone

In this order, because each one has failed in production for somebody:

1. Start a shift, lock the phone, put it in a pocket, drive for twenty minutes. The route must be
   continuous. **This is the whole feature.** If it has holes, nothing else matters.
2. Force-quit the app mid-shift. Android's foreground service should survive; iOS will not. Check
   what the admin map says — it must show INTERRUPTED, never a straight line across the gap.
3. Turn the phone off for ten minutes mid-shift, then on. The queued points must arrive and land
   in the right places in the route, not appended to the end of it.
4. Deny the "Always" permission and grant "While Using". The portal must say tracking is limited —
   it must not claim recording is running.
5. Leave it recording for a full shift and read the battery figure. If it is unacceptable, the
   sampling floor in organization settings is the dial, not the code.

## What this layer deliberately does not do

No uploading, no retry policy, no batching — those live in `packages/tracking-client`, and a second
copy here is how two upload paths end up disagreeing about what was sent. No distance arithmetic:
every number that matters is computed on the server from the points it stored. No collection
outside a session: there is no boot receiver, no idle service, and no state this app can be in
where it is recording and the server has not authorised a shift or a trip.

Simulated fixes are discarded rather than stored. Android's mock-location setting and the iOS
simulator both produce positions indistinguishable from real ones except for the flag the plugin
sets, and accepting them would let a route be fabricated from a phone.
