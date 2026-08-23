# Tracking client

How a route gets recorded on the device, and what happens when the screen goes off.

**This product is web-based.** That is a decision, not a gap, and it fixes what the recording can
and cannot do. This document is about living with that honestly rather than about routing around
it.

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

So there is exactly one way to keep recording while the phone is in a pocket: **the Screen Wake
Lock** — keep the display on for the duration of the shift. It works in the browser today, the
screen stays lit, the battery drains faster, and nothing is lost. That is the trade, and the
portals state it before a shift starts.

**Installing the app to the home screen does not change this.** It is worth doing for other
reasons — see §5 — but an installed PWA is still web content and still gets no background-location
permission. Any screen that implied otherwise would be making a promise the platform will break.

`detectCapabilities()` reports what the current device has, and the portals state it plainly. This is deliberate. A driver who believes their route is being
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
LocationCollector            the port both portals are written against
   └── WebLocationCollector      watchPosition + wake lock + IndexedDB queue

createLocationCollector()    returns the web collector
detectCapabilities()         what this device can do, for the UI to state
PointQueue                   IndexedDB, with an in-memory fallback
decideSampling()             re-exported from @aytracker/tracking
```

One implementation, and the port stays anyway: the portals are better off depending on the
interface than on the class, and a collector is far easier to test through it.

There is deliberately **no dormant native branch**. A code path that reports "recording continues
with the screen off" is false in a web product, and an unreachable one is worse than none — it
survives review indefinitely because nobody ever runs it. If a native shell is ever built, it
arrives as a new capability and a new collector, not as a branch kept warm for years.

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

## 5. Installing it — what a PWA does and does not buy

The app is installable: `apps/web/src/app/manifest.ts` is the manifest, `apps/web/public/sw.js`
the service worker, and `apps/web/src/lib/pwa.ts` the hook that registers one and offers the other.

**What installing does not do:** unlock background GPS. An installed PWA is still web content. It
gets no background-location permission on either platform, and every notice in the portals says so.

**What it does do**, all of which matters on a shift:

|                          |                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An icon instead of a URL | Nobody types an address at 05:40 in a yard. This is the single biggest reason field staff actually open the app.                                                                                                    |
| Its own task on Android  | An installed app is backgrounded far less aggressively than a tab. The stretch between locking the screen and the recording stopping is longer, and the app is much less likely to be discarded outright mid-shift. |
| No browser chrome        | A URL bar and a tab strip cost about a fifth of a phone screen on a full-screen control surface.                                                                                                                    |
| Home-screen shortcuts    | Long-press goes straight to "Моята смяна" or "Курс".                                                                                                                                                                |

### The service worker

It caches the app shell and **nothing else**. Requests to `/api/` are not intercepted at all — they
are not cached, not revalidated, not touched. This is not a performance decision:

> Every screen in this product reports how far somebody drove, how long they worked, and whether
> their phone is reporting right now. A cached copy of any of those is a confident, plausible lie.
> A supervisor reading a stale live map would conclude a van is somewhere it left twenty minutes
> ago.

Navigations are network-first with the last good copy as a fallback, because a stale HTML document
paired with a live API is how a client starts sending a request shape the server stopped accepting.
Hashed build assets under `/_next/static/` are cache-first: their URLs contain a content hash, so a
given URL's bytes never change.

The queue of unsent GPS points is **not** in the service worker. It is in IndexedDB, owned by this
package, and it survives without any of this.

Registration happens in the `/worker` and `/driver` route layouts, which means it covers the login
screens too. That is the point: an installed app opens at the login screen, and caching the shell
only after sign-in would be exactly one visit too late for the worker with no signal.

### Verified

- The manifest and all five icons serve, and the manifest link and `apple-touch-icon` are in the
  document head.
- The worker registers, activates and takes control of the page.
- After an API call, the cache holds shell entries and **zero** `/api/` entries.
- With the network cut, the login screen still renders with all its controls.

---

## 6. What the driver is told

The notice keys in `capabilities.ts` map to what the device can really do:

| Capability        | Message                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| `WAKE_LOCK`       | Recording works while the screen is on. The app keeps it awake during the shift. |
| `FOREGROUND_ONLY` | Keep the app open to record the route. Interruptions are marked.                 |
| `NONE`            | This device does not support location tracking.                                  |

**No capability promises screen-off recording**, because none can. The wording takes the
application's name as an argument rather than hardcoding "AYtracker": the product is white-label,
and the name in that sentence has to be the one on the bar above it. The keys are resolved through
`@aytracker/localization` — never English literals from the capability module, since the person
reading may not read English.

---

## 7. Testing

- **Unit** — sampling decisions, queue overflow order, status transitions. No browser needed.
- **Integration** — the upload path against a real API, including a duplicate batch to prove
  idempotency holds.
- **Manual, and unavoidable** — lock the phone mid-trip on each target platform and confirm the
  recorded track matches what the notice promised. This is the one claim that cannot be verified in
  CI, and it is also the one a driver will notice first.
