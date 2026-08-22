# GPS tracking

Location data is sensitive operational data about identifiable people. Everything in this
document follows from taking that seriously.

---

## 1. Pipeline

```
Driver PWA
   │  adaptive sampling (device-side)
   ▼
POST /api/v1/driver/location          rate limited, entitlement-gated
   │
   ├─ validateLocationBatch           trip ACTIVE? coordinates valid? timestamps in window?
   ├─ appendMany                      createMany, one round trip
   ├─ computeTrackDistance            recomputed from all stored points
   ├─ deriveTrackingState             from observable facts only
   └─ record a TrackingEvent          only on a state transition
   ▼
PostgreSQL
   ▼
Admin map / trip history / cost reports
```

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

The server sends the policy to the device (`GET /driver/state`), so it can be tuned per
organization without shipping a new client.

**The server treats it as a floor, not a promise.** `admitPoints` independently drops points
arriving faster than the configured minimum. An over-eager or hostile client gains nothing, and
does not get its whole batch rejected either — dropping is quieter than failing and protects the
driver's legitimate data.

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

A scheduled sweep (`detectInterruptions`) catches trips that have gone quiet — without it, a trip
whose device died would sit at `ACTIVE` forever and the dashboard would show a driver as tracked
when nothing is arriving.

---

## 6. Consent and visibility

**The driver always knows when tracking is active.**

```
🔴 LOCATION TRACKING ACTIVE
   Trip: Sofia → Plovdiv
   Tracking started: 08:42
```

- Location is collected **only** during an `ACTIVE` trip. `validateLocationBatch` refuses points
  for a planned, paused, completed or cancelled trip — enforced at ingestion, not left to the
  client to honour.
- Starting and stopping tracking are driver actions.
- Pausing stops collection.
- Nothing is collected outside a trip. There is no background mode.

---

## 7. Privacy and retention

| Data            | Default retention | Rationale                                       |
| --------------- | ----------------- | ----------------------------------------------- |
| Raw GPS points  | 180 days          | Sensitive; the operational value decays quickly |
| Trip summaries  | 5 years           | Cost and payroll reporting                      |
| Tracking events | With the trip     | The record of what happened                     |
| Audit records   | 7 years           | Legal                                           |

Both windows are per-organization settings. Deleting raw points does **not** invalidate a
year-old cost report, because the summary carries distance, duration and gaps. That separation is
the whole reason the windows differ.

Coordinates are stored at 6 decimal places (~0.11 m). More precision than the sensor provides is
a privacy cost with no operational benefit.

Access is permission-gated: `fleet.tracking.read` for live locations and route history. A driver
sees only their own trips — enforced by the query filter, so another driver's trip is not found
rather than forbidden.

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

`tests/unit/tracking.test.ts` (38):

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
Server-side admission control drops over-frequent points
```
