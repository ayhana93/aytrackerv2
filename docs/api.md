# API

`/api/v1`. REST over JSON, cookie sessions, Zod-validated.

---

## 1. Conventions

**Versioning** — `/api/v1`. A breaking change means `/api/v2` alongside it, not a mutation of v1.

**Authentication** — an HTTP-only session cookie. No bearer tokens, no API keys yet (API access is
a Business-plan feature and will use scoped keys when built).

**CSRF** — every POST/PUT/PATCH/DELETE needs `x-csrf-token` matching the `ay_csrf` cookie.

**Idempotency** — every offline-capable mutation takes `clientActionId` (UUID) in the body.

**Errors** — one shape:

```json
{
  "error": {
    "code": "shift.already_active",
    "kind": "CONFLICT",
    "requestId": "0193…",
    "details": {}
  }
}
```

Clients branch on `code` and render a translated string looked up from it. `requestId` is echoed
in the `x-request-id` header on every response.

**No identity in requests.** No endpoint accepts a `workerId`, `driverId`, `organizationId`, role,
permission, or price. Those come from the session.

---

## 2. Endpoints

### Auth — `/api/v1/auth`

| Method | Path            | Auth    | Notes                                |
| ------ | --------------- | ------- | ------------------------------------ |
| POST   | `/login`        | —       | Admin. 10/min per IP                 |
| POST   | `/worker/login` | —       | Slug + employee number + PIN. 5/min  |
| POST   | `/driver/login` | —       | Slug + driver code + PIN. 5/min      |
| POST   | `/logout`       | session | Revokes the session                  |
| GET    | `/me`           | session | Actor, permissions, enabled features |

### Market — `/api/v1/market`

| Method | Path       | Auth     | Notes                                                     |
| ------ | ---------- | -------- | --------------------------------------------------------- |
| GET    | `/`        | optional | Resolved market and `isTaxAuthoritative`                  |
| GET    | `/pricing` | optional | Public price list for the resolved market                 |
| GET    | `/quote`   | session  | Net + tax + total; needs an authoritative billing country |

With a session, the market comes from the organization's billing country and every query
parameter is ignored ([market-pricing.md](market-pricing.md) § 2).

### Worker portal — `/api/v1/worker`

Requires a **worker session**.

| Method | Path                      | Permission                   |
| ------ | ------------------------- | ---------------------------- |
| GET    | `/state`                  | `worker.portal.access`       |
| POST   | `/shift/start`            | `worker.shift.start`         |
| POST   | `/shift/end`              | `worker.shift.end`           |
| POST   | `/break/start`            | `worker.break.manage`        |
| POST   | `/break/end`              | `worker.break.manage`        |
| POST   | `/position/change`        | `worker.position.change`     |
| GET    | `/position/history`       | `worker.history.read`        |
| GET    | `/positions/:id/vehicles` | `worker.position.change`     |
| POST   | `/driving/begin`          | `worker.position.change`     |
| GET    | `/sync/state`             | + `offline.mode` entitlement |

`/state` is the whole worker screen in one response: the worker, their open shift with its
current position and open break, **only the positions they may occupy** — named, with the work
area each sits in — and `serverTime`.

`serverTime` is not decoration. Every elapsed time the portal renders is measured against it
rather than against `Date.now()`, so a tablet whose clock is hours out cannot show a shift that
began a minute ago as having run all morning.

`/shift/start` takes no `siteId`: the site is resolved from the worker's own record. One may
still be supplied by a terminal fixed to a single entrance.

`/position/change` takes exactly one of `positionId` or `qrToken`.

### Driver portal — `/api/v1/driver`

Requires a **driver session** and the `driver.portal` entitlement.

| Method | Path            | Permission             |
| ------ | --------------- | ---------------------- |
| GET    | `/state`        | `driver.portal.access` |
| GET    | `/vehicles`     | `driver.vehicle.view`  |
| POST   | `/trip/start`   | `driver.trip.start`    |
| POST   | `/trip/:id/end` | `driver.trip.stop`     |
| GET    | `/trips`        | `driver.trip.history`  |
| GET    | `/trips/:id`    | `driver.trip.history`  |

**There is no pause, and no `driver.trip.pause` permission.** A trip records from the moment it
starts until the driver ends it. Pausing let a driver stop the recording, cover a hundred
kilometres and resume — fuel burned against no trip, and a straight line drawn through the middle
of the route. Standing still needs no button: a stationary vehicle produces a stop on its own
track, detected server-side from the points ([tracking.md](tracking.md) § stops).

`/state` returns the assigned vehicle, the active trip, the fuel estimate for the distance so
far, `serverTime`, and the sampling policy the device should follow. The fuel block is `null`
unless the vehicle has a recorded consumption; its `cost` is `null` unless the organization has
entered a fuel price. Neither is ever invented.

`/vehicles` lists what this driver may take right now — active, not held by anyone else, with
the one they drove last sorted first. `/trip/start` accepts a `vehicleId` from that list when the
driver holds no assignment; the assignment it creates is automatic and is released when the trip
ends. A driver who already holds a vehicle drives that one, whatever the body says.

`/trip/start` also accepts an optional `label` (the route) and `plannedDistanceKm`. Both are
optional — most trips have no route worth declaring — and a planned distance without a label is
refused, because a number with no route attached cannot be checked later.

Location is **not** submitted here. There is one ingestion endpoint for the whole product —
`/api/v1/tracking/points` below — because a worker's phone on shift and a driver's phone on a trip
must pass the same admission rules. Two endpoints would have meant two sets of rules, and the day
they disagree is the day a payroll figure and a fuel figure stop adding up.

### Tracking — `/api/v1/tracking`

Requires a **worker or driver session** and the `fleet.gps_tracking` entitlement. Never a
management user: an admin account has no device stream and no session to write to.

| Method | Path      | Permission        |
| ------ | --------- | ----------------- |
| POST   | `/points` | `tracking.submit` |
| GET    | `/state`  | `tracking.submit` |

`/points` accepts up to 500 points, rate limited to 120 requests/minute per organization.

**The device never names its session.** The open session for the authenticated actor is a
server-side lookup, and with no open session the request is refused with
`403 tracking.no_open_session` — refused rather than silently discarded, so the client stops
draining the battery. Nothing the body claims about identity, vehicle, trip, distance or tracking
state is trusted; each is resolved or recomputed on the server. See
[workforce-tracking.md](workforce-tracking.md).

The response reports `accepted`, `rejected` (outside the session window, or malformed), `dropped`
(faster than the sampling floor), the derived `state` and the session's recomputed
`distanceMeters`.

`/state` returns whether a session is open, what it has recorded so far, and the sampling policy
the device should follow — one small read a collector can poll cheaply on reconnect to find out
whether it should still be running at all.

### Admin portal — `/api/v1/admin`

Requires a **user session**. A worker session elevated for driving is still refused here: a
management portal is for people, not for a device token.

| Method | Path                    | Permission            |
| ------ | ----------------------- | --------------------- |
| GET    | `/dashboard`            | `reports.read`        |
| GET    | `/history`              | `shifts.read`         |
| GET    | `/workers`              | `workers.read`        |
| POST   | `/workers`              | `workers.create`      |
| PATCH  | `/workers/:id`          | `workers.update`      |
| GET    | `/areas`                | `positions.read`      |
| POST   | `/areas`                | `positions.manage`    |
| PATCH  | `/areas/:id`            | `positions.manage`    |
| POST   | `/positions`            | `positions.manage`    |
| PATCH  | `/positions/:id`        | `positions.manage`    |
| GET    | `/vehicles`             | `fleet.read`          |
| POST   | `/vehicles`             | `fleet.create`        |
| GET    | `/trips`                | `fleet.tracking.read` |
| GET    | `/trips/:id/track`      | `fleet.tracking.read` |
| GET    | `/workforce`            | `workers.read`        |
| GET    | `/live`                 | `fleet.tracking.read` |
| GET    | `/live/:id/track`       | `fleet.tracking.read` |
| GET    | `/geofences`            | `settings.read`       |
| POST   | `/geofences`            | `settings.update`     |
| PATCH  | `/geofences/:id`        | `settings.update`     |
| GET    | `/geofences/:id/visits` | `fleet.tracking.read` |
| GET    | `/branding`             | `branding.read`       |
| GET    | `/settings`             | `settings.read`       |
| PATCH  | `/settings`             | `settings.update`     |

`/dashboard` answers "who is working right now" from open position sessions, and reports
tracking warnings as observations rather than accusations.

`/workforce` returns the counts — employed, working, on break, driving, reporting, not reporting,
untracked — computed in the database rather than by summing a capped list in a browser. "At work
but not reporting" is its own figure and is never folded into the green number: a phone that has
gone quiet means we cannot say where somebody is, and hiding that would be the first small lie a
tracking product tells.

`/live` is every open tracking session, one row per marker, with the last fix and the derived
state. Employees and vehicles are not two lists because they are not two things — a worker driving
a van is one person with one phone. `/live/:id/track` returns that day split into WORK and
DRIVER_TRIP segments, with gaps returned explicitly so the renderer breaks the line rather than
drawing through them.

`/geofences` manages the places arrivals are recorded against, and `/geofences/:id/visits` returns
the stays. A visit with no exit is reported open: the record says they went in and has not seen
them leave, and an invented departure time would be the easiest way to make a customer report
wrong.

`/settings` carries the operational configuration: the fuel price per litre, whether workers may
open their own shifts, the maximum shift length before an abandoned one is auto-closed, and the
GPS sampling floor handed to devices, the geofence tuning, and the speed limit alerts are measured
against. `PATCH` applies only the fields the request carries — an omitted field is never reset to a
default nobody asked for.

`fuelPricePerLiter` and `speedLimitKph` both accept `null` explicitly, which clears them. "We no
longer want costs estimated" and "we no longer want speed alerts" are real intents, and neither is
the same as saying nothing. `speedLimitKph` is null by default, and null means no speed alerting at
all — there is no national default and no guess from the road type, because reporting an employee
against a number their employer never set is the sort of figure that ends up quoted in a
disciplinary meeting.

### Health

`GET /health/live` — process only, **never touches the database**. A liveness probe that fails on
a slow query restarts a healthy container during an incident, turning a degradation into an
outage.

`GET /health/ready` — includes a database check.

---

## 3. Planned

Domain and schema exist; routes are pending, most behind the design phase.

```
/organizations   /users        /sites        /work-areas    /positions
/workers         /shifts       /production   /reports       /recommendations
/drivers         /fleet/vehicles   /fleet/assignments   /fleet/trips
/fleet/fuel      /fleet/expenses   /fleet/documents     /fleet/maintenance
/billing         /sync
```

---

## 4. Rate limits

| Scope                 | Limit                    |
| --------------------- | ------------------------ |
| Admin login           | 10/min per IP            |
| Worker / driver login | 5/min per IP             |
| Location ingestion    | 120/min per organization |
| Everything else       | 300/min                  |

Keyed by organization when authenticated, by IP otherwise — a factory behind one NAT must not
exhaust the limit for everyone behind it.

---

## 5. Commands, not CRUD

Critical mutations are explicit commands: `POST /worker/position/change`, not
`PATCH /position-sessions/:id`.

The difference matters. A command carries intent, so the server can validate the whole operation,
run it atomically, emit one meaningful event, and refuse an invalid state transition. A generic
PATCH invites a client to construct a state the domain has no rule for.

---

## 6. OpenAPI

`@fastify/swagger` is wired. Because request schemas are already Zod, the specification is
generated from the same definitions the API validates against — so it cannot drift from
behaviour. Published at `/docs` in non-production environments.
