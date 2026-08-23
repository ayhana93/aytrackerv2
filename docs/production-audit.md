# Production Audit

A targeted audit of AYtracker v2 at commit `b40017a`. The brief was to inspect before changing,
fix only concrete defects, and leave correct code alone. Most of what was inspected was correct
and is listed as such; seven things were wrong and were fixed.

Baseline before this audit: 342 unit tests, 190 integration tests, all passing. After: 348 unit,
201 integration, all passing.

---

## Already Correct — No Changes Required

**GPS distance integration** (`packages/tracking/src/geo.ts`). The specific concern raised —
whether a fix rejected for poor accuracy lets its two good neighbours become one continuous
segment — is handled correctly. The accuracy filter runs first, then every check that follows
(`maxGapSeconds`, `maxSpeedMps`, `minSegmentMeters`) is applied to the _surviving_ pairs using real
wall-clock elapsed time. So one dropped fix between two good ones two minutes apart is bridged, as
it should be: that is the same evidence as two fixes two minutes apart with nothing between them.
Twenty minutes of dropped fixes is not bridged, because the surviving pair is twenty minutes apart
and the gap rule catches it. Both cases now have regression tests pinning them. Out-of-order points
are sorted; identical timestamps produce zero elapsed time and are skipped; the stationary-jitter
floor is pinned by an existing test asserting exactly 0 metres from 60 jittery points.

**Server-side GPS admission** (`modules/tracking/src/domain/admission.ts`). Coordinates are
validated for finiteness and range before storage; negative accuracy is refused; timestamps outside
the session window are dropped rather than dragged onto the nearest edge, with only a two-minute
clock-skew tolerance; batches are capped at 500; the trip a fix belongs to is decided from its
timestamp server-side and never from the request. Nothing a device claims about distance, session,
identity or trip is trusted.

**Stop detection.** Anchored on the cluster's first point rather than a rolling centre, so a slow
crawl through traffic cannot drift one radius at a time into a reported stop. A silence longer than
the gap threshold breaks the cluster wherever it falls, so two fixes an hour apart in the same car
park are one departure and one arrival rather than a one-hour stop.

**Tenant isolation.** Every Prisma call in `apps/api/src` and `modules/*` was enumerated and
checked. Every tenant-scoped read carries `organizationId` in the query itself; every write is
authorised by a preceding read that did. The handful of calls without it are correct: global tables
(users, plans, markets, sessions), the deliberately public white-label branding lookup, and
read-then-write pairs where the tenant was already established. Underneath that, composite
`(organizationId, id)` foreign keys make a cross-tenant reference unrepresentable rather than
merely unlikely, and RLS is a third layer. Cross-tenant access reports 404, not 403. Twelve
integration tests cover it directly.

**Authentication and authorization.** Session token is opaque and HTTP-only; `ActorContext` is
built from the session row and nothing else; no route in the worker or driver files takes an actor
id at all. CSRF is double-submit and enforced on every mutating method. Expiry and revocation are
checked on every request. PIN lockout, generic login errors for unknown/wrong credentials, and
per-route rate limits on the login endpoints are all present and tested. A password or email change
invalidates prior sessions through `credentialsChangedAt` with no sweep required. (The one real gap
found here is under **Fixed**.)

**Idempotency.** Same key + same body replays the stored response verbatim; same key + different
body is a hard 409 `idempotency.key_reused`; a failed command releases its claim so a genuine retry
can proceed. All three are tested. The unique index makes the claim atomic. (The behaviour of the
_loser_ of that race is under **Fixed**.)

**Database invariants.** Extensive and enforced by PostgreSQL, not convention: partial unique
indexes for every "at most one open X" rule, ~50 check constraints, unique employee numbers and
vehicle registrations per organization, ~36 composite tenant foreign keys. `schema-invariants.test.ts`
reads the live catalog rather than the migration files, so a migration that drops one fails the
suite regardless of how it was dropped. Violations are mapped onto domain errors rather than 500s.

**Input and file security.** Image type is sniffed from magic numbers and never taken from the
caller; SVG is refused outright rather than sanitised, with the reasoning written down; base64 is
re-encoded and compared so prose cannot arrive as a handful of accidental bytes; 512 KB cap. Zod
schemas cover request bodies throughout. Nine tests. No changes.

**Event bus.** Inspected as instructed, and the answer is that no outbox is needed: the in-process
bus currently has **zero subscribers**. Every `publish` call is a no-op, so no event can be lost by
a crash between commit and delivery. Building an outbox now would be infrastructure for a problem
that does not exist. The obligation is recorded under **Remaining Issues** for the first subscriber
that must not lose work.

**Pagination.** Every collection endpoint that can grow with usage already had a cap (200–1000) and
the wide reads were deliberate. The genuinely unbounded reads found were reporting aggregations, and
the right fix for those was to aggregate in SQL rather than to paginate — see **Fixed** §4.

---

## Fixed

### 1. The map drew a route through fixes the distance had rejected

**Problem.** `HaversineRoutingProvider.reconstruct()` computed distance from the accuracy-filtered
sequence, returned **every stored row** as a polyline vertex, and derived `gapAfterIndices` from the
**raw** timeline — three walks over three different sequences, all rendered on one screen.

**Why it mattered.** Two visible failures, on the endpoint that exists to be honest about routes:

- A 2 km-accuracy cell-tower fix was drawn as a place the vehicle had been — a spike out to a
  street it was never on — with a distance printed beside it that excluded exactly that spike.
- Worse: a stretch where the phone reported nothing _but_ unusable fixes has no silence in the raw
  timeline, so no break was emitted and the line was drawn straight across minutes the integrator
  had already refused to count. That is precisely the fabrication `gapAfterIndices` exists to
  prevent, produced by the function that produces `gapAfterIndices`. `docs/tracking.md` §5 states
  the rule it was breaking: "Route lines are not drawn across a gap."

This is the picture someone prints and puts in front of a driver.

**What changed.** `geo.ts` exports `usableTrackPoints()` (one definition of "a fix we can believe")
and `DistanceResult` gained `breakAfterIndices` — the points after which the integrator refused to
connect, whether for a gap past the limit or an impossible speed. `reconstruct()` now filters once,
integrates once, and returns points, breaks and distance from the same walk. The trip-route
endpoint's `pointCount` now counts drawn vertices rather than table rows, so the number beside the
map describes the map.

**Tests.** Six new unit tests: the A→rejected→C case is still bridged; a run of rejected points is
reported as a gap and breaks the line; a teleport breaks the line; a rejected fix is not drawn; an
ordinary track is unbroken. Existing route tests still pass unchanged.

### 2. A re-sent GPS batch was stored twice

**Problem.** No unique constraint on `location_points`, and no application check either — despite
`routes/tracking.ts` and `docs/offline-sync.md` both stating that "appending the same point twice is
prevented".

**Why it mattered.** This is the ordinary consequence of a bad connection, not an exotic race. The
device queue drops a point only once the server acknowledges it, so a response lost on the way back
leaves the whole batch queued and it is sent again. Every point in it is then at or before the
newest stored one, which routes it through the offline-replay bucket — and that bucket is thinned
only against itself, deliberately, so that a two-hour-old queued fix is not discarded for being
older than the newest live one. Nothing stood between the replay and a second copy of the
afternoon. The arithmetic survived it (two fixes at one instant have zero elapsed time, so distance,
stops and gaps were never wrong), but the highest-volume table in the product grew in proportion to
how poor a driver's signal was, which is exactly backwards.

**What changed.** A unique index on `(organizationId, trackingSessionId, timestamp)`, replacing the
plain index of the same three columns rather than joining it — two indexes on one shape would double
the write cost of every ingested point to buy nothing. The migration de-duplicates existing rows
first, keeping the earliest by uuid v7 ordering. `appendMany` passes `skipDuplicates: true`, so a
retry is a quiet no-op rather than a failed upload for a driver whose connection is already poor.
The ingest response reports `accepted` as rows actually stored plus a new `duplicates` count.

**Tests.** An integration test sends the same batch twice and asserts 4 stored, `accepted: 0` and
`duplicates: 4` on the replay. Two schema-invariant tests assert the unique index exists and that a
second index of the same shape has not reappeared.

### 3. A malformed date returned a confident report about a different period

**Problem.** `request.query as { from?: string }` is a cast, not a check. `resolveRange` built
`new Date('yesterday')`, noticed the `NaN`, and silently substituted the last 24 hours. `limit` was
`Math.min(Number(query.limit ?? 250), 1000)`, so `limit=abc` reached Prisma as `take: NaN`.

**Why it mattered.** `?from=yesterday` returned **200 with a full report**, and echoed the
substituted window in `range` as though it had been requested. A reader has no way to distinguish a
report about the period they asked for from a report about a period the server chose — and these
figures sit next to payslips and fuel costs. `limit=abc` returned a 500: the server taking the blame
for the client's typo, and an error page where a validation message belonged.

**What changed.** `packages/validation/src/reporting.ts` adds Zod schemas for the reporting query
strings, applied to `/admin/dashboard`, `/admin/history`, `/admin/trips`,
`/admin/geofences/:id/visits` and `/driver/trips`. Malformed dates, a `to` before `from`, a
non-numeric limit and a limit above the endpoint's ceiling are all `400 validation.failed` naming
the field. Absent bounds still mean "the usual window for this screen" — absent is not malformed —
and the 92-day cap still narrows an over-wide but well-formed range, echoed in `range`.
`resolveRange` now takes `Date`s and no longer contains a fallback path.

**Tests.** Five new integration tests. One existing test — `survives a malformed date instead of
returning a 500`, which asserted 200 — was rewritten to assert 400: it pinned the behaviour this
audit was asked to change, and the rewrite is deliberate rather than incidental.

### 4. The dashboard and work history loaded whole tables to add up two columns

**Problem.** `/dashboard` read every production entry in the range — with a joined position and work
area — and reduced them in Node: two sums, an hourly bucketing and a group-by. It read every trip in
the range to produce a count and three sums. `/history` ran a second, entirely uncapped `findMany`
over every matching position session to build the per-worker roll-up.

**Why it mattered.** The window is caller-controlled up to 92 days. A factory recording a few
thousand production entries a day puts hundreds of thousands of joined rows across the wire, on the
most-requested endpoint in the product, so that the API process can add up two columns.

**What changed.** Trip totals use `driverTrip.aggregate`. The hourly series and the per-work-area
breakdown are two grouped SQL queries returning one row per hour and one per area (raw SQL because
the grouping key is `date_trunc('hour', …)`, which Prisma's `groupBy` cannot express; tenant and
range are bound parameters, and the tenant is repeated on the joins). Grand totals are summed from
the hourly rows, so the KPI and the chart cannot disagree. The history roll-up is now a `groupBy`
for closed sessions plus an individual read of open ones — bounded by headcount, because
`position_sessions_one_open_per_worker` makes "one open session per worker" a database guarantee —
plus a `count` for the truncation flag. `durationSeconds` is written on every close and every
correction, so the split on `endedAt` partitions the rows exactly and the total is unchanged.

Hour bucketing also moved to explicit UTC on both sides. It previously used the API process's local
time for the boundaries and UTC for the keys, so the same entry landed in different hours on two
machines serving the same organization.

**Tests.** Covered by the existing dashboard and work-history integration tests, which assert the
totals, the roll-up, the "totals the whole range even when the list is capped" behaviour and the
zero-filled chart — all unchanged and still passing, which is the point.

### 5. Deactivating a worker did not sign them out

**Problem.** `SessionService.revokeForActor` existed, was documented in ADR 0005, in
`docs/authentication.md` and in `docs/offline-sync.md` as the price of snapshotting permissions onto
the session — and **had no call sites anywhere in the codebase**.

**Why it mattered.** The request path reads the permission snapshot and never re-reads the worker's
status, and no command checks it either. So a worker marked INACTIVE kept a fully valid session for
the rest of its sixteen-hour life: worker portal, clock-in, position changes and location streaming
all continued to work, hours after the organization had said they should not. The same held for a
PIN reset — the old PIN stopped working and the phone already signed in carried on regardless,
which is exactly the case a reset exists for. `docs/offline-sync.md` claimed the session was
revoked.

**What changed.** `PATCH /admin/workers/:workerId` revokes the worker's sessions, and those of any
linked driver profile, when the status moves away from ACTIVE or the PIN is replaced. Awaited before
responding — an admin must not be told "deactivated" until the sessions are gone. The response
carries `sessionsRevoked` so the screen can say what happened, since an admin resetting a PIN
mid-shift has just stopped that worker's phone reporting.

**Tests.** Three integration tests: a deactivated worker's live session goes 200 → 401; a PIN reset
does the same; an ordinary name correction does not sign anybody out mid-shift.

### 6. Losing the idempotency claim race returned a 500

**Problem.** `claim()` reads, then inserts. Two concurrent replays of the same queued action can
both find nothing; the unique index correctly lets only one through, but the loser's `P2002` was not
in the constraint-to-error map, so it fell through to `500 error.internal`.

**Why it mattered.** The guarantee that matters — one business mutation — always held. But the loser
was a client behaving correctly, on the endpoints a flaky connection retries hardest, and
`docs/offline-sync.md` explicitly claimed it "is told the action is in flight".

**What changed.** `claim()` catches the unique violation and throws
`409 idempotency.in_progress` — the same answer the PENDING branch a millisecond later would give.

**Tests.** Covered by the existing idempotency suite; the change makes the documented behaviour true
rather than adding a new one.

### 7. The live map showed a green dot for a phone that had died

**Problem.** `tracking_sessions.trackingState` is written only by ingestion. `detectInterruptions`
exists to age quiet sessions and **nothing schedules it** — there is no cron, no worker process and
no job runner in this deployment.

**Why it mattered.** The column is frozen for exactly the device that stopped reporting. A phone
that died at lunch stayed ACTIVE on the live map and inside the "reporting" count for the rest of
the shift. The code's own comment names this: "the live map shows a green dot for a phone that
stopped reporting at lunchtime — which is worse than showing nothing, because somebody believes it."

**What changed.** `/admin/live` and `/admin/workforce` derive the state from `lastPointAt` and the
last accuracy at read time, through the same pure `deriveTrackingState` the sweep would have used,
instead of trusting the stored column. `deviceReported` is passed as null deliberately: replaying an
hour-old "OFFLINE" claim as current would be a different kind of lie. This does not replace the
sweep — the `TrackingEvent` row for the interruption is still missing from the log until the device
returns — and the scheduler is tracked below.

**Tests.** An integration test backdates `lastPointAt` by an hour, asserts the stored column still
says ACTIVE, and asserts the map reports INTERRUPTED and the workforce count reports `reporting: 0`,
`notReporting: 1`.

### 8. A rate-limit setting that did nothing

**Problem.** `app.ts` carried `...(config.env.REDIS_URL ? {} : {})` — a spread that is empty in both
branches — under a comment saying `REDIS_URL` switched rate limiting to a shared store.

**Why it mattered.** It never did. Rate limiting is in-process, so with N replicas the effective
limit is N times the number written, and the login limiter is weaker than it reads. An operator who
set `REDIS_URL` had every reason to believe otherwise.

**What changed.** The dead spread is gone, the comment states the truth, and boot logs a warning
when `REDIS_URL` is set while rate limiting is in-process. Wiring the shared store is a dependency
and a deployment decision rather than a bug fix; it is tracked below.

---

## Remaining Issues

### CRITICAL

**Raw GPS points are never deleted.** `deleteOlderThan` exists at the repository level and nothing
calls it. There is no scheduler, and no per-organization setting to read a retention window from, so
the documented 180-day window does not exist and points accumulate indefinitely. For a product whose
central claim is that location is collected only inside authorised working time, unbounded retention
is the gap in that promise that matters most, and the first thing a customer's data-protection
review will ask about. Needs a scheduled job and the settings column; the sizing note in
`docs/database.md` (~520 MB/month at target scale) is what accrues meanwhile. Documentation
corrected to say so.

### HIGH

**No scheduler exists at all.** Two documented behaviours are methods with no caller:
`detectInterruptions` (fix 7 mitigates the visible symptom, not the missing event log) and
`deleteOlderThan` (above). Whatever form it takes — a cron container, a Railway scheduled job, an
in-process timer — this is one piece of infrastructure that unblocks both.

**Rate limiting does not hold across replicas.** See fix 8. Single-replica deployments are
unaffected; the moment the API scales horizontally the login and ingestion limits are multiplied by
the replica count. Needs a shared store (`ioredis` is not currently a dependency).

**`revokeForActor` is a standing obligation for three cases with no route yet.** Role change, role
permission change and membership removal all invalidate a session's permission snapshot, and no
endpoint performs them today. The first route that does must call `revokeForActor` in the same
request or it reopens fix 5. Recorded as a table in `docs/authentication.md` and in ADR 0005.

**RLS is inert against the database owner.** Documented in ADR 0003 and `client.ts`, and correct as
a design: the application-layer tenant filter is the primary control. But it means the third layer
of tenant isolation exists only if the deployment connects as a non-owner role. This is a
deployment checklist item, not a code change, and it is not currently verified anywhere in CI.

### MEDIUM

**`findTrackingGaps` counts unusable fixes as "reported".** It is fed raw timestamps, so twenty
minutes during which the phone sent nothing but 2 km-accuracy fixes produces no gap and contributes
nothing to `untrackedSeconds` — while `computeTrackDistance` excludes those minutes entirely and,
after fix 1, the map now draws a break there. Three views of the same stretch, and the honest answer
is that we do not know where the vehicle was. Not changed here because `untrackedSeconds` is stored
and comparable across historical trips, so the semantics are a deliberate call rather than a bug
fix; it should be made deliberately.

**The audit log write is outside the transaction it describes.** Documented at `recordAudit` with
the reasoning (an audit write that can fail the operation turns a logging problem into an outage),
and the trade is stated: a crash between the two loses the record. Fine for settings changes;
revisit if audited operations ever touch money.

**The trip-route endpoint reads a whole trip's points into memory.** Bounded in practice — a 24-hour
trip at the 15-second floor is under 6,000 rows — and the endpoint has to return a polyline, so
there is nothing to aggregate. Worth a cap if trips ever run for days.

**No pagination cursor on the reporting endpoints.** They cap with `take` and report `truncated`,
which is honest, but a caller cannot page past the cap. Fine for the current screens; a cursor is
the answer if a customer needs a full export.

### LOW

**`hashRequestBody` is key-order dependent.** `JSON.stringify` of a re-ordered body produces a
different hash, so a client that serialised the same logical request differently on retry would get
`idempotency.key_reused` instead of a replay. All current clients build the body in one place, so
this cannot fire today.

**`uniqueAreaCode` / `uniquePositionCode` loop up to 50 queries.** Only on collision, and the unique
index remains the authority, so the worst case is 50 cheap reads on an organization with 50
similarly named areas.

---

## Accepted Tradeoffs

**Permissions snapshotted onto the session.** Authorization is one indexed read instead of a role
join per request. The cost is explicit invalidation, which is now wired for the two cases that have
routes and recorded as an obligation for the three that do not. ADR 0005.

**In-process event bus, no outbox.** Correct for the current system precisely because there are no
subscribers. The first subscriber whose work must survive a crash between commit and delivery needs
a PostgreSQL outbox — not a broker. Recorded here so that decision is made deliberately rather than
discovered.

**Conservative GPS distance that under-reports.** Deliberate, documented in ADR 0006, and the right
direction: under-reporting is a uniform bias a fleet manager can calibrate against, while
over-reporting invents distance that may feed pay. Genuine movements under 10 m are lost.

**Raw SQL for two dashboard aggregations.** Prisma's `groupBy` cannot group by a computed
expression. Two tagged-template queries with bound parameters is a smaller cost than either
returning hundreds of thousands of rows or introducing a query builder.

**Read-then-write for tenant authorisation.** Writes target a row already fetched with the tenant in
the `where`, rather than repeating `organizationId` in the update. Safe because ids are opaque uuids
and a row cannot change organization, and it is what produces "not found" rather than "forbidden"
for a cross-tenant id.

**`admin.ts` is 2,600 lines and stays that way.** Inspected as instructed for business logic that
belongs in application services. The genuine domain logic — trip state, shift and position
transitions, eligibility, tracking admission, fuel arithmetic — already lives in `modules/*` behind
ports, and the route file calls into it. What is left is validation, authorization, tenant-scoped
reads and response shaping, plus the reporting aggregations. Splitting it by file size, or extracting
repository classes for single-use reads, would add indirection without moving a decision anywhere
better. The aggregation helpers moved to named functions at the bottom of the file, which is the only
part that was doing real work in the wrong shape.

**No pause on a trip.** A driver who could pause and cover a hundred kilometres would make the fuel
figure meaningless. The state and the arithmetic remain only so historical trips keep their totals.

---

## Final Assessment

**Architecture:** Strong. Modules are genuinely decoupled behind ports, the dependency direction is
enforced by ESLint rather than by review, and the reasoning behind each boundary is written down
next to it. `admin.ts` is large but is a route file doing route-file work.

**Security:** Strong, with one real hole now closed. Session handling, CSRF, actor-type separation,
lockout and generic auth errors are all correct and tested. The gap was not in the design — it was a
documented invalidation path with no call sites, which is the failure mode this codebase's style
(write the rule next to the code) is otherwise good at preventing.

**Database:** The strongest part of the system. Invariants live in PostgreSQL, the constraint catalog
is asserted by tests that read the live catalog, and cross-tenant references are unrepresentable
rather than merely checked. One missing uniqueness guarantee found and added.

**GPS:** Sound arithmetic, honest about what it does not know, and now consistent between the number
and the picture. The filters, the gap rules and the refusal to infer intent from silence are the
best-reasoned code in the repository. Retention is the outstanding gap and it is a serious one.

**API:** Consistent and well-shaped. Query-string validation was the one place where the outer
boundary was a cast rather than a check, and it is now Zod like everything else.

**Performance:** Adequate for target scale after this audit. Reporting no longer streams tables into
Node to add them up; the remaining reads are capped or bounded by domain invariants. The unindexed
risk is retention, not query shape.

**Testing:** Unusually good. 549 tests, and the integration suite tests behaviour rather than
implementation — including the properties that would otherwise silently rot, like the database
catalog and the absence of a pause endpoint. Every fix in this audit landed with a regression test
that fails against the old code.

**Deployment:** The weakest area, and the reason several items above are HIGH rather than MEDIUM.
There is no scheduler, rate limiting does not survive horizontal scaling, and RLS depends on a
database role choice that nothing verifies. None of these are code defects; all of them are things a
production deployment needs and does not yet have.

**Overall:** A well-built system with a small number of real defects, now fixed, and a clear gap
between what is built and what is operationally deployed. The code is production-quality. The
deployment is not yet production-complete, and the retention gap should block a customer launch
until it is closed.
