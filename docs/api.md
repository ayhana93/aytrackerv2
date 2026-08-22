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

| Method | Path            | Permission                                      |
| ------ | --------------- | ----------------------------------------------- |
| GET    | `/state`        | `driver.portal.access`                          |
| GET    | `/vehicles`     | `driver.vehicle.view`                           |
| POST   | `/trip/start`   | `driver.trip.start`                             |
| POST   | `/trip/:id/end` | `driver.trip.stop`                              |
| POST   | `/location`     | `driver.location.submit` + `fleet.gps_tracking` |
| GET    | `/trips`        | `driver.trip.history`                           |
| GET    | `/trips/:id`    | `driver.trip.history`                           |

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

`/location` accepts up to 500 points, rate limited to 120 requests/minute per organization.

### Admin portal — `/api/v1/admin`

Requires a **user session**. A worker session elevated for driving is still refused here: a
management portal is for people, not for a device token.

| Method | Path               | Permission            |
| ------ | ------------------ | --------------------- |
| GET    | `/dashboard`       | `reports.read`        |
| GET    | `/history`         | `shifts.read`         |
| GET    | `/workers`         | `workers.read`        |
| POST   | `/workers`         | `workers.create`      |
| PATCH  | `/workers/:id`     | `workers.update`      |
| GET    | `/areas`           | `positions.read`      |
| POST   | `/areas`           | `positions.manage`    |
| PATCH  | `/areas/:id`       | `positions.manage`    |
| POST   | `/positions`       | `positions.manage`    |
| PATCH  | `/positions/:id`   | `positions.manage`    |
| GET    | `/vehicles`        | `fleet.read`          |
| POST   | `/vehicles`        | `fleet.create`        |
| GET    | `/trips`           | `fleet.tracking.read` |
| GET    | `/trips/:id/track` | `fleet.tracking.read` |
| GET    | `/branding`        | `branding.read`       |
| GET    | `/settings`        | `settings.read`       |
| PATCH  | `/settings`        | `settings.update`     |

`/dashboard` answers "who is working right now" from open position sessions, and reports
tracking warnings as observations rather than accusations.

`/settings` carries the operational configuration: the fuel price per litre, whether workers may
open their own shifts, the maximum shift length before an abandoned one is auto-closed, and the
GPS sampling floor handed to driver devices. `PATCH` applies only the fields the request carries
— an omitted field is never reset to a default nobody asked for. `fuelPricePerLiter` accepts
`null` explicitly, which clears it: "we no longer want costs estimated" is a real intent, and it
is not the same as saying nothing.

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
