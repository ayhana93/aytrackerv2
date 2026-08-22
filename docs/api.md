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

### Branding — `/api/v1/branding`

| Method | Path            | Auth | Notes                                                      |
| ------ | --------------- | ---- | ---------------------------------------------------------- |
| GET    | `/logos/:id`    | —    | The image bytes. Sniffed `Content-Type`, `nosniff`, cached |
| GET    | `/public?slug=` | —    | A tenant's name, logo, colour and login message            |

**Unauthenticated on purpose.** A login page has to render a customer's name and logo before
anybody has proved who they are; requiring a session would put the vendor's name on every
customer's front door. Both routes publish only what the company code already publishes, and
nothing else about the tenant is served here ([white-label.md](white-label.md) § 4).

### Admin settings — `/api/v1/admin`

| Method | Path                  | Permission            | Notes                                             |
| ------ | --------------------- | --------------------- | ------------------------------------------------- |
| GET    | `/organization`       | `organization.read`   | Name, legal name, login code, status              |
| PATCH  | `/organization`       | `organization.update` | Renames the tenant. The slug is not editable      |
| GET    | `/branding/logos`     | `branding.read`       | The gallery, with the chosen one marked           |
| POST   | `/branding/logos`     | `branding.update`     | Base64 upload; type sniffed, SVG refused          |
| POST   | `/branding/logo`      | `branding.update`     | Chooses one, or `null` for none                   |
| DELETE | `/branding/logos/:id` | `branding.update`     | Deleting the chosen one clears it                 |
| GET    | `/members`            | `users.manage`        | The organization's management seats               |
| PATCH  | `/members/:id/email`  | `users.manage`        | Ends that user's sessions; never a platform admin |

### Worker portal — `/api/v1/worker`

Requires a **worker session**.

| Method | Path                | Permission                   |
| ------ | ------------------- | ---------------------------- |
| GET    | `/state`            | `worker.portal.access`       |
| POST   | `/shift/start`      | `worker.shift.start`         |
| POST   | `/shift/end`        | `worker.shift.end`           |
| POST   | `/break/start`      | `worker.break.manage`        |
| POST   | `/break/end`        | `worker.break.manage`        |
| POST   | `/position/change`  | `worker.position.change`     |
| GET    | `/position/history` | `worker.history.read`        |
| GET    | `/sync/state`       | + `offline.mode` entitlement |

`/state` returns the worker, their open shift with its current position session and open break,
and **only the positions they may occupy**.

`/position/change` takes exactly one of `positionId` or `qrToken`.

### Driver portal — `/api/v1/driver`

Requires a **driver session** and the `driver.portal` entitlement.

| Method | Path               | Permission                                      |
| ------ | ------------------ | ----------------------------------------------- |
| GET    | `/state`           | `driver.portal.access`                          |
| POST   | `/trip/start`      | `driver.trip.start`                             |
| POST   | `/trip/:id/pause`  | `driver.trip.pause`                             |
| POST   | `/trip/:id/resume` | `driver.trip.pause`                             |
| POST   | `/trip/:id/end`    | `driver.trip.stop`                              |
| POST   | `/location`        | `driver.location.submit` + `fleet.gps_tracking` |
| GET    | `/trips`           | `driver.trip.history`                           |
| GET    | `/trips/:id`       | `driver.trip.history`                           |

`/state` returns the assigned vehicle, the active trip, and the sampling policy the device should
follow. `/location` accepts up to 500 points, rate limited to 120 requests/minute per
organization.

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
