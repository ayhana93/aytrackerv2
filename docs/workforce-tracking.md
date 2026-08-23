# Workforce tracking

One GPS engine. Two contexts. No second pipeline.

`docs/tracking.md` covers the arithmetic — distance, gaps, sampling, states. This document covers
the thing that owns it: who may report, what owns the points, and why a working day and a driver
trip are one stream rather than two.

---

## 1. The problem this shape solves

Before this, a location point could only exist against a driver trip. That made two things
impossible at once:

- An employee who is not driving could not be tracked at all. The worker portal had no tracking,
  and the admin map could only ever show vehicles.
- A driver who ended a trip stopped being tracked mid-shift, even though they were still at work.

The obvious fix — a second pipeline for workforce location — is the wrong one. Two pipelines means
two sets of admission rules, two distance calculations and two state machines, and the day the two
disagree is the day nobody can defend a payroll figure or a fuel figure. So instead there is one
owner for every point:

```
TrackingSession(context = WORK | DRIVER_TRIP)
    ├── LocationPoint    (tripId set when the fix happened during a trip)
    ├── TrackingEvent
    └── GeofenceVisit
```

A worker who drives produces **one** session. The trip's points are the working day's points with
a trip attached — the day's route and the trip's route are two readings of the same rows, never
two copies of them.

---

## 2. Privacy is structural, not documentary

A `LocationPoint` has a `NOT NULL` tracking session. A session exists only while a shift or a trip
does. **There is no row this schema can hold that represents location collected outside authorised
working time.**

That is the whole privacy design, and it is deliberately expressed as a foreign key rather than as
a rule somebody remembers. The consequences:

- `POST /tracking/points` with no open session returns `403 tracking.no_open_session`. Not a silent
  discard — the client is told so it stops draining the battery.
- Ending a shift closes the session. The next batch from that phone is refused.
- There is no endpoint, no admin action and no background job that can open a session without a
  shift or a trip behind it.

The device never names its session. It could not be trusted to, and it does not need to: the open
session for the authenticated actor is a server-side lookup.

---

## 3. The one flow

| Event                                                | What happens to tracking                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Worker clocks in                                     | A `WORK` session opens. Exactly one per shift.                                        |
| Worker takes a vehicle                               | **Nothing opens.** The running WORK session picks up the trip as an overlay.          |
| Worker ends the trip                                 | **Tracking continues.** `trackingStopped: false`.                                     |
| Worker clocks out                                    | The session closes. Further points are refused.                                       |
| Driver signs in at the driver door and starts a trip | A `DRIVER_TRIP` session opens — otherwise nothing would authorise their phone at all. |
| That driver ends the trip                            | The session closes with it.                                                           |

`attachTrip` is where this is decided, and it is four lines of consequence: if the worker already
has an open WORK session, return it; otherwise open a DRIVER_TRIP session.

### Which trip a point belongs to

Decided server-side, from the timestamp, per point:

```ts
tripForTimestamp(timestamp, trip); // half-open: [startedAt, endedAt)
```

A batch that spans the moment a driver ended their trip therefore splits correctly: the fixes
before the end carry the trip, the ones after do not. A client that names a trip it is not on
gains nothing, because the client is never asked.

---

## 4. What the server refuses

Every rule below runs on every batch from every device, in `modules/tracking/src/domain/admission.ts`.

**The session must be open.** See §2.

**Timestamps outside the session window are refused, not moved.** Only drift small enough to be a
clock artefact — two minutes — is corrected onto the window edge. Anything further out is dropped
and counted.

> This one was found by running the flow rather than reading it. Clamping an out-of-window fix to
> the nearest edge placed an employee somewhere they were not, at a time they were not there, and
> collapsed a day into alternating one-minute segments. A fix we cannot place in this session is
> not evidence about this session.

**Coordinates are validated.** A malformed pair is dropped rather than stored and filtered later:
a NaN in a Decimal column outlives every reader that would have to guard against it.

**Batches are capped** at 500 points. This is the highest-frequency writer in the system and the
most attractive way to try to exhaust it.

**The sampling floor is enforced.** `/tracking/state` hands every device a minimum interval; a
client that ignores it has its batch thinned rather than failed. An over-eager client should not
be able to lose an employee's whole upload.

The floor is applied in two buckets. Points newer than the last one stored are _live_ and thinned
against it. Points at or before it are an _offline replay_ and thinned only against each other —
measuring a two-hour-old queued fix against the newest stored point would discard the entire
replay, which is real data about a stretch of the day there is otherwise no evidence for.

**Nothing the client sends about itself is trusted.** Not `employeeId`, not `organizationId`, not
the role, not the vehicle, not the distance, not the duration, not the tracking state. Each is
resolved from the session cookie or computed from stored rows.

---

## 5. Derived, not accumulated

Distance, geofence visits and speed alerts are all **recomputed from the whole stored point stream**
on every batch, never added to a running total.

This costs more per batch and is worth it. An offline replay that fills in the middle of an
afternoon arrives out of order; a running total would bake that ordering in permanently, and the
figure would stay wrong forever. Recomputation means a late upload _corrects_ the record.

For visits, it also means the stored rows are made equal to what the points support — created,
closed, or removed. A replay that shows what looked like a visit was actually a phone losing
signal at a red light deletes the visit rather than leaving it on a customer's report.

Only the _differences_ produce events. Logging every re-derived crossing would put the same arrival
in the event log two hundred times over an afternoon.

Both derivations are skipped entirely when the organization has configured neither fences nor a
speed limit, which is most organizations on day one.

---

## 6. Geofences

A circle: a centre and a radius. Not a polygon — a radius is something a dispatcher sets from a
phone in ten seconds and can reason about afterwards, and every geofence in this product exists to
answer a question about arrival rather than to trace a boundary.

Two problems make the naive version unusable, and both are solved in
`packages/tracking/src/geofence.ts`:

**Flapping.** A phone parked on the boundary reports 48 m, 51 m, 49 m, 52 m. Without hysteresis
that is an enter/exit every fifteen seconds all afternoon, and the supervisor turns alerts off by
lunchtime. So entering takes crossing the radius; leaving takes crossing a wider one. The band
between them is where nothing happens.

**Noise.** A crossing must hold for a debounce period before it counts, so driving past the depot
is not a visit. Fixes too inaccurate to place inside the fence are skipped rather than guessed at:
a 300 m error cannot put anyone inside a 150 m circle, and the honest answer is that nothing
changed.

A visit still open when the points run out is reported open. **There is no estimated exit time.**
The record says they went in and has not seen them leave; inventing a departure would be the
easiest possible way to make the customer report wrong.

Tuning lives in organization settings: `geofenceExitHysteresisMeters` (default 40) and
`geofenceDebounceSeconds` (default 90).

---

## 7. Speed alerts

**Off by default, and off means silent.** `speedLimitKph` is null until somebody sets one. There is
no national default and no guess from the road type: reporting an employee for exceeding a number
their employer never chose is the sort of figure that ends up quoted in a disciplinary meeting.

When a limit is set, an alert is a **stretch**, not a sample — one event per continuous period over
the limit, carrying the peak reached and how long it lasted. A cooldown (default ten minutes) stops
stop-start motorway traffic producing twenty alerts for one journey.

The device's own speed is preferred over distance-over-time. A GPS receiver measures velocity from
Doppler shift and is good at it; dividing the distance between two fixes by the interval turns
every position error into a speed error. When a derived figure is used, the event says
`source: 'DERIVED'` — it is weaker evidence, and anything acting on it should be able to tell.

---

## 8. What the admin sees

`GET /admin/live` — every open session, one row per marker, with the last fix and the derived
state. Employees and vehicles are not two lists, because they are not two things: a worker driving
a van is one person with one phone reporting one stream.

A WORK session never points at a trip, so the running trip is resolved **by subject**. Reading the
vehicle off the session alone showed every driving employee as a person with no vehicle — on the
one screen that exists to answer "who has which van".

`GET /admin/live/:sessionId/track` — the day, split into WORK and DRIVER_TRIP segments derived from
`tripId` on consecutive points, with gaps returned explicitly.

`GET /admin/workforce` — the counts, computed in the database rather than by summing a capped list
in a browser. "At work but not reporting" is its own line, never folded into the green number.

Colour on the map encodes tracking state and nothing else. Grey is not an accusation: a tunnel, a
flat battery and a force-quit are the same thing from the server, and the system says what it
observes, never what it infers about intent.

---

## 9. What is deliberately absent

- **No pause.** There is no endpoint, no permission, and no UI. A driver who could pause and then
  cover a hundred kilometres would make the fuel figure meaningless. Stops appear on the route by
  themselves — see `detectStops`.
- **No route requirement.** A trip can be started with no label at all. Most trips are "went out,
  came back", and forcing a route to be declared before a vehicle may move is how a tracker becomes
  something drivers work around. When a planned distance _is_ given, the actual is measured against
  it.
- **No interpolation across gaps.** The renderer breaks the line. There is no version of this data
  where a straight line is drawn across nineteen minutes nobody can account for.
- **No claim about intent.** The system never records that a driver _disabled_ tracking, because it
  cannot know that.

---

## 10. Where it lives

| Concern                                   | Location                                                        |
| ----------------------------------------- | --------------------------------------------------------------- |
| Geometry, states, sampling, fences, speed | `packages/tracking` — pure functions, no database               |
| Sessions, admission, ingestion            | `modules/tracking`                                              |
| What a trip _is_                          | `modules/drivers`                                               |
| Ingestion endpoint                        | `apps/api/src/routes/tracking.ts`                               |
| Live map and workforce reads              | `apps/api/src/routes/admin.ts`                                  |
| Device collectors and the offline queue   | `packages/tracking-client`                                      |
| Native shell                              | `apps/mobile` — see its README for what has _not_ been verified |

`modules/drivers` no longer contains an ingestion path, a pause, or a location pipeline. It owns
trips. That split is what stops the product growing a second pipeline the day somebody needs to
track an employee who is not driving.
