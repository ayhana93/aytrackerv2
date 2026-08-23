# GPS tracking

Location data is sensitive operational data about identifiable people. Everything in this
document follows from taking that seriously.

This document is the **arithmetic**: sampling, distance, states, gaps, retention.
**[`docs/workforce-tracking.md`](./workforce-tracking.md)** is the **engine** that owns it — who
may report, what owns the points, and why a working day and a driver trip are one stream rather
than two. Read that one first if you are trying to understand the shape.

---

## 1. Pipeline

```
Worker or driver device       (browser, or the same app installed to the home screen)
   │  adaptive sampling (device-side, floor set by the server)
   ▼
POST /api/v1/tracking/points          rate limited, entitlement-gated
   │
   ├─ resolveSession                  the OPEN session for this actor — never named by the client
   ├─ admitPoints                     session open? coordinates valid? timestamp inside the window?
   │                                  which trip was running at that instant?
   ├─ sampling floor                  thin anything faster than the configured minimum
   ├─ appendMany                      createMany, one round trip; a fix already held for this
   │                                  session at this instant is skipped, so a re-sent batch
   │                                  stores nothing twice
   ├─ computeTrackDistance            recomputed from all stored points
   ├─ deriveTrackingState             from observable facts only
   ├─ detectGeofenceVisits            recomputed; only new crossings produce events
   ├─ detectSpeedAlerts               one event per stretch, never per sample
   └─ record a TrackingEvent          only on a state transition
   ▼
PostgreSQL
   ▼
Admin live map / workforce counts / work route history / trip history / cost reports
```

There is exactly one ingestion endpoint for the whole product. A worker's phone on shift and a
driver's phone on a trip post the same body to the same URL; the server decides which session owns
the points and whether a trip was running when each fix was taken. Two endpoints would have meant
two sets of admission rules, and the day they disagree is the day a payroll figure and a fuel
figure stop adding up.

---

## 2. Adaptive sampling

"Do not send GPS every second" is easy to say and easy to over-correct into uselessness. The
policy trades three things:

- **battery** — the dominant cost across an 8-hour shift on a driver's own phone;
- **fidelity** — a route sampled too coarsely cuts corners and under-reports distance;
- **write volume** — this is the highest-frequency writer in the system.

```ts
DEFAULT_SAMPLING_POLICY = {
  minIntervalSeconds: 15, // never more often, whatever else is true
  maxIntervalSeconds: 60, // at least this often while moving
  minDistanceMeters: 50, // emit once the vehicle has moved this far
  stationarySpeedMps: 1.5, // below ~5 km/h counts as stopped
  stationaryIntervalSeconds: 120,
  lowBatteryThreshold: 0.15,
  lowBatteryIntervalSeconds: 180,
};
```

The server sends the policy to the device (`GET /tracking/state`), so it can be tuned per
organization without shipping a new client.

**The server treats it as a floor, not a promise.** Ingestion independently thins points arriving
faster than the configured minimum. An over-eager or hostile client gains nothing, and does not get
its whole batch rejected either — thinning is quieter than failing and protects the employee's
legitimate data.

The floor is applied in two buckets: points newer than the last one stored are thinned against it;
points at or before it are an offline replay and are thinned only against each other. Measuring a
two-hour-old queued fix against the newest stored point would discard the whole replay, which is
real data about a stretch of the day there is otherwise no evidence for.

---

## 3. Distance

`computeTrackDistance` is deliberately conservative: **it under-reports rather than over-reports.**
Distance feeds fuel estimates and, in some organizations, driver pay. Inventing metres from GPS
noise would be the worst bug this system could have.

| Filter              | Default       | Rejects                           |
| ------------------- | ------------- | --------------------------------- |
| `maxAccuracyMeters` | 100           | Cell-tower fixes and indoor drift |
| `minSegmentMeters`  | 10            | **Stationary jitter**             |
| `maxSpeedMps`       | 60 (216 km/h) | Sensor glitches and teleports     |
| `maxGapSeconds`     | 300           | Segments across a coverage hole   |

The jitter filter is the important one. A phone on a dashboard wanders several metres; summing
that across a lunch break invents kilometres. A test feeds 60 stationary points with realistic
jitter and asserts the distance is exactly **0**.

Haversine rather than Vincenty: for segments of tens of metres to a few kilometres the
ellipsoidal correction is far below GPS noise, and haversine has no convergence failure mode.

Distance is **recomputed from all stored points at trip close**, not accumulated — so a trip that
synced out of order still ends with the right number.

### A rejected fix is a hole, not a shortcut

A point dropped for poor accuracy leaves its neighbours adjacent, and they are then measured
against each other by real wall-clock time. That is the right answer for one dropped fix — two
credible points two minutes apart are the same evidence whether or not something unusable sat
between them — and it is also the right answer for twenty minutes of them: the surviving fixes are
twenty minutes apart, past the bridging limit, so nothing is counted and the gap is reported.

**The drawn route is made of the same points as the distance.** It was not always: `reconstruct()`
integrated the filtered sequence but returned every stored row as a vertex, and derived the line
breaks from the raw timeline. Three walks over three different sequences, all rendered on one
screen. A stretch where the phone reported nothing but 2 km cell-tower fixes has no silence in the
raw timeline, so the map drew an unbroken line across minutes the integrator had already refused to
count, through vertices at places the vehicle was never near — the fabrication `gapAfterIndices`
exists to prevent, produced by the function that produces `gapAfterIndices`. It now filters once,
integrates once, and breaks the line wherever the integration refused to bridge: a gap past the
limit, or a segment implying an impossible speed.

---

## 4. Tracking states, and what they refuse to claim

```
ACTIVE       fresh, accurate points arriving on schedule
DEGRADED     still arriving, but late or low-accuracy
PAUSED       a historical state; no driver can produce it any more — see below
INTERRUPTED  nothing received past the stale threshold, trip still open
OFFLINE      the device told us it lost connectivity
STOPPED      no active tracking session
```

### Nothing a driver can press produces PAUSED

There is no pause control and no `driver.trip.pause` permission. A trip records from the moment
it starts until the driver ends it.

Pausing was the one control that let the vehicle keep moving while the record stopped: press
pause, drive a hundred kilometres, press resume, and the fuel burned in that window belongs to
nobody while the route shows a straight line across the middle. Standing still needs no button —
a stationary vehicle produces a stop on its own track, detected server-side from the points.

The state and the arithmetic that excludes pause intervals both remain, because trips recorded
before this was removed still carry `TRACKING_PAUSED` events, and their totals must stay what
they always were.

### The anti-tampering rule

**The system never concludes that a driver deliberately stopped tracking.**

A tunnel, a dead battery, an OS killing a background task, and a revoked permission all look
similar from the server. So the model reports what is observable and leaves intent out of it:

| Event                  | Says                            |
| ---------------------- | ------------------------------- |
| `APP_NOT_REPORTING`    | App no longer reporting         |
| `LOCATION_UNAVAILABLE` | Location unavailable            |
| `PERMISSION_DISABLED`  | Location permission not granted |
| `DEVICE_OFFLINE`       | Device offline                  |
| `SIGNAL_DEGRADED`      | Location signal weak            |
| `REPORTING_RECOVERED`  | Location updates resumed        |

None of these accuses anyone. There is no `DRIVER_DISABLED_TRACKING` event, and there is no state
that asserts intent — a test asserts the state union to keep it that way.

Derivation order matters: a `PAUSED` trip — only ever a historical one now — is never called
interrupted, and an explicit device report beats an inference from silence.

---

## 5. Gaps

`findTrackingGaps` returns the intervals during an active trip when no location arrived.

```
⚠ Tracking interruption
  Driver: Ivan          Vehicle: CA1234AB
  Last update: 14:32    Tracking unavailable: 14:32 → 14:51
```

Rules:

- **Route lines are not drawn across a gap.** A straight line over 19 minutes is a fabrication.
  `reconstruct()` returns `gapAfterIndices` so the renderer breaks the line.
- **Distance is not interpolated across a gap.** The segment is excluded and the time is reported
  as `untrackedSeconds` on the trip.
- **Pause intervals on historical trips are not gaps.** They are excluded, so a trip recorded
  before pausing was removed keeps the totals it always had.
- **Silence before the trip ends is a gap.** A phone that died 10 minutes before arrival leaves
  10 minutes we cannot account for, and saying so is the point.

`untrackedSeconds` is a first-class column on `DriverTrip`, not something buried in a log. A trip
with 19 minutes missing is a different fact from a fully tracked one.

`detectInterruptions` exists to age open sessions that have gone quiet — and **nothing schedules
it.** There is no cron, no worker process and no job runner in this deployment, so the sweep is a
method with no caller and `tracking_sessions.trackingState` is only ever written by an ingest.

Which means the column is frozen for exactly the device that stopped reporting. The live map and
the workforce counts therefore **derive** the state from `lastPointAt` at read time rather than
trusting the column, so a phone that died at lunch is INTERRUPTED on the screen from the moment it
goes past the stale threshold. What is still missing without the sweep is the `TrackingEvent` row:
the interruption shows on the map but does not appear in the session's event log until the device
comes back and the next ingest records the transition. See docs/production-audit.md.

---

## 6. Consent and visibility

**The person being tracked always knows when tracking is active.** The portal shows it for the
whole time it is running, and on Android the platform's own persistent notification says the same
thing independently — a promise is worth more when the operating system enforces it too.

- Location is collected **only** while a tracking session is open, and a session exists only while
  a shift or a trip does. This is a `NOT NULL` foreign key, not a rule somebody remembers: there is
  no row the schema can hold that represents location collected outside authorised working time.
  See [`docs/workforce-tracking.md` §2](./workforce-tracking.md).
- `POST /tracking/points` with no open session returns `403 tracking.no_open_session` — refused
  rather than silently discarded, so the device stops draining its battery into a void.
- Clocking in starts it; clocking out ends it. Ending a trip does **not** end it, because the
  employee is still at work — but ending the shift does, and the next batch is refused.
- There is no pause. See §4.2: a driver who could pause and then cover a hundred kilometres would
  make the fuel figure meaningless.
- This is a web product, so recording needs the screen on — a Screen Wake Lock keeps it on while a
  session is open. Installing the app to the home screen does not change that; it makes Android
  slower to shut the app down, which is a longer grace period, not a background permission.

---

## 7. Privacy and retention

| Data                       | Default retention | Rationale                                       |
| -------------------------- | ----------------- | ----------------------------------------------- |
| Raw GPS points             | 180 days          | Sensitive; the operational value decays quickly |
| Session and trip summaries | 5 years           | Cost and payroll reporting                      |
| Tracking events            | With the session  | The record of what happened                     |
| Geofence visits            | With the session  | Arrival times feed customer reports             |
| Audit records              | 7 years           | Legal                                           |

Deleting raw points does **not** invalidate a year-old cost report, because the summary carries
distance, duration and gaps. That separation is the whole reason the windows differ.

**These are the intended windows, and nothing enforces them yet.** `deleteOlderThan` is written
and tested at the repository level, but — like `detectInterruptions` — it has no scheduler to call
it and no per-organization setting to read a window from. So raw GPS points are currently kept
indefinitely. For a product whose central claim is that location is collected only inside
authorised working time, an unbounded retention window is the gap in that promise that matters
most, and it is the first thing a customer's data-protection review will ask about. Tracked as
CRITICAL in docs/production-audit.md.

Coordinates are stored at 6 decimal places (~0.11 m). More precision than the sensor provides is
a privacy cost with no operational benefit.

Access is permission-gated: `fleet.tracking.read` for live locations, route history and geofence
visits; `workers.read` for the workforce counts. A driver sees only their own trips — enforced by
the query filter, so another driver's trip is not found rather than forbidden.

A geofence visit is a customer address paired with somebody's whereabouts, which makes it exactly
the kind of row that must not leak across a tenant boundary because of one forgotten `WHERE`
clause. Both `geofences` and `geofence_visits` carry composite tenant foreign keys and an RLS
policy, checked by `tests/integration/schema-invariants.test.ts`.

---

## 8. Provider abstraction

```ts
interface RoutingProvider {
  reconstruct(points): Promise<ReconstructedRoute>;
  reverseGeocode?(point): Promise<PlaceLabel | null>;
}
```

The default `HaversineRoutingProvider` is pure geometry over our own points: no network, no API
key. A vendor (Mapbox, Google, OSRM) is only ever an enhancement — road snapping, place names —
never a dependency the system stops working without.

So route history and distance keep working when a vendor is down, rate-limited, or unpaid. The
domain never imports a map SDK.

A future telematics integration (a hardware tracker rather than a phone) arrives through the same
adapter shape: points in, same validation, same storage.

---

## 9. Scale

Target: 100 active drivers, 8 h/day, ~20 s effective sampling.

```
100 × 8 × 180 ≈ 144 000 points/day ≈ 4.3 M/month ≈ 520 MB/month with indexes
```

Handled by: adaptive sampling, server-side admission control, batch inserts (`createMany`), a
batch cap of 500, and retention.

The ingestion path does the minimum — validate, append, update running distance and state.
Route reconstruction, stop detection and gap analysis are read-side and stay out of the hot path.

If volume outgrows one table, the path is monthly range partitioning on `timestamp`: the access
pattern suits it, and retention becomes `DROP PARTITION` instead of a mass delete. Not done yet
because premature partitioning costs planning complexity for no current benefit.

---

## 10. Tests

`tests/unit/tracking.test.ts` — the arithmetic:

```
Haversine against a known distance
Stationary jitter integrates to exactly 0
Low-accuracy points rejected; impossible speeds rejected
A long gap is reported, never bridged
Stop detection
Every tracking-state derivation, including PAUSED never reading as INTERRUPTED
Gap detection, including trailing silence and pause exclusion
Fuel: the spec's worked example, mpg conversion, brim-to-brim consumption, cost per km
Sampling decisions: first point, interval floor, distance threshold, low battery, stationary
The sampling floor thins over-frequent points
```

`tests/unit/tracking-admission.test.ts` — what a device is allowed to add to the record:

```
No session, no collection; a closed session refuses too
A fix from yesterday is rejected, not dragged onto the session start
A fix from the future is rejected, not dragged onto now
Drift small enough to be a clock artefact is corrected
A queued offline replay from inside the window is kept, and marked as backfill
Malformed coordinates and negative accuracy are dropped
The trip overlay is decided from the timestamp, splitting a batch across a trip's end
```

`tests/unit/geofence-and-speed.test.ts` — restraint:

```
One visit for an arrival, a stay and a departure
No flapping when a device sits on the boundary
No visit invented from driving past
Fixes too inaccurate to place inside the fence conclude nothing
An open visit stays open rather than getting an invented exit
One alert per speeding stretch, placed where the worst of it happened
Nothing at all when no limit is configured
No second alert inside the cooldown, and one again once it passes
Device speed preferred; a derived figure is labelled as such
```

`tests/integration/api-security.test.ts` — the engine end to end: the session opens with the
shift and refuses points before it, one session survives a trip starting inside it, tracking
continues after the trip ends, everything is refused after the shift ends, one stay produces one
visit however many batches it took, and speed alerting says nothing until a limit is set.
