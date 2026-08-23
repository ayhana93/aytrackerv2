# AYtracker v2 — Architecture

The one document to read first. It states the decisions everything else follows from, and links
to the document that covers each in depth.

---

## 1. What AYtracker is

A multi-tenant B2B SaaS platform for manufacturing and operational companies. It tracks who
worked where and for how long, what they produced, and what the vehicles that serve the
operation cost to run.

It is **not** an ERP. It does not do accounting, procurement, or CRM, and the architecture is
built so that adding a module never requires the system to become one.

Core modules today:

```
workforce · shifts · position tracking · production · productivity · reporting
drivers · vehicles · fleet costs
```

Planned, and already accounted for in the module boundaries:

```
quality · maintenance · inventory · production planning · OEE · machine monitoring
documents · notifications · AI assistant · integrations · advanced analytics
```

---

## 2. The five decisions everything else follows from

### 2.1 The server is the source of truth

Nothing a client sends decides who the caller is, what they may do, or what the business state
becomes. The server never trusts a client-supplied worker id, organization id, role, permission,
price, market, production total, duration, driver identity, vehicle identity, or GPS history.

Concretely, this is why:

- Worker and driver routes take **no** actor id — identity comes from the session row
  ([authentication.md](authentication.md)).
- A fuel expense sends litres and unit price; the server computes the total
  ([driver-fleet.md](driver-fleet.md)).
- Trip distance is recomputed from stored points at close time; the device's own figure is never
  stored ([tracking.md](tracking.md)).
- A visitor may select a market; an authenticated organization's market comes only from its
  billing country ([market-pricing.md](market-pricing.md)).

### 2.2 Tenant isolation is enforced three times

Application, authorization, and database — each independently sufficient to catch the mistake
the other two might make. See [multi-tenancy.md](multi-tenancy.md).

The database layer is the one worth naming here because it is unusual: every child row carries
`organizationId`, and every parent has a `UNIQUE (organizationId, id)` that children reference
as a **composite foreign key**. A shift cannot point at another tenant's site. Not "should not" —
cannot; the insert fails.

### 2.3 Business logic lives in domain and application services

React renders and captures interaction. It does not decide whether a worker may occupy a
position, how long a shift was, or what a trip cost. Every rule in this system is a pure
function or an application service that can be tested without a browser, and most of them are
tested exactly that way.

### 2.4 Critical operations are atomic

Start/end shift, breaks, position changes, production records, corrections, trip
start/pause/resume/end, vehicle assignment, and fuel expenses each commit as a unit. Where the
application check could lose a race, a database constraint decides the winner — see
[position-management.md](position-management.md) for the canonical example.

### 2.5 A module is added, never woven in

Adding a module means: module code, migrations, permissions, entitlements, routes, tests, and
optionally a feature flag. It does not mean editing unrelated modules. See
[modular-architecture.md](modular-architecture.md).

---

## 3. Monorepo structure

```
AYtracker/
├── apps/
│   ├── web/                  Next.js — admin, worker and driver portals; installable PWA
│   └── api/                  Fastify — the only writer of business state
├── packages/
│   ├── types/                branded ids, actor context. No runtime deps.
│   ├── config/               environment schema, parsed once at boot
│   ├── domain/               errors, Result, money, time, event bus
│   ├── validation/           Zod schemas shared by API and web
│   ├── auth/                 permissions, roles, Argon2id, sessions, lockout
│   ├── localization/         locales, catalogs, formatting
│   ├── market/               MarketResolver, CurrencyService, TaxService
│   ├── billing/              PricingCatalog, Entitlements, BillingProvider
│   ├── tracking/             geometry, tracking state, fuel, sampling, geofences, speed
│   ├── database/             Prisma client, tenant scoping, error translation
│   └── ui/                   white-label theming (components await the design phase)
├── modules/
│   ├── workforce/  shifts/  production/  reporting/
│   ├── drivers/    fleet/   recommendations/  audit/
│   └── tracking/             sessions, admission, the one ingestion path
├── tests/                    unit, integration, e2e
├── infrastructure/           deployment configuration
└── docs/
```

### Dependency rules

Layering, lowest first. An arrow may only point downward.

```
apps/*
  ↓
modules/*                     (may depend on other modules only via their public index)
  ↓
packages/database             (the only package allowed to import @prisma/client)
  ↓
packages/{auth, localization, market, billing, tracking}
  ↓
packages/{domain, validation}
  ↓
packages/{types, config}
```

Additional rules, all machine-enforced in `eslint.config.js`:

| Rule                                                                | Enforced by                     |
| ------------------------------------------------------------------- | ------------------------------- |
| No deep imports into another module (`@aytracker/module-x/src/...`) | `no-restricted-imports` pattern |
| No Prisma in a module's `domain/` or `application/` layer           | `no-restricted-imports` path    |
| No React or Next in any business-logic package                      | `no-restricted-imports` path    |
| No `const enum` (breaks `isolatedModules`)                          | `no-restricted-syntax`          |

A module's `infrastructure/` folder **is** allowed to import `@aytracker/database` — that is
where its repository ports get their Prisma implementations, and it is the only place that
knows a database exists.

---

## 4. Technology, and why

| Choice                                         | Reason                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript, strict, `noUncheckedIndexedAccess` | Every id in this system is a string; branded types are what stop a worker id being passed as an organization id                                                                                                                           |
| pnpm workspaces + Turborepo                    | Content-hash caching means CI rebuilds only what changed                                                                                                                                                                                  |
| Fastify over NestJS                            | The brief said prefer Fastify if it keeps the architecture simpler. It does: the composition root is one readable file rather than a decorator graph                                                                                      |
| PostgreSQL + Prisma                            | Partial unique indexes, composite foreign keys, check constraints and RLS are all load-bearing here. Prisma's migration story is good; its query builder is escaped via `$queryRaw` where the schema language cannot express an invariant |
| Next.js 15 / React 19                          | PWA support for the worker and driver portals, server rendering so a white-labelled login page never flashes the wrong brand                                                                                                              |
| Zod                                            | One schema definition shared by the API boundary and the web forms                                                                                                                                                                        |
| Vitest + Playwright                            | Fast unit runs; real-browser E2E                                                                                                                                                                                                          |
| Railway                                        | Managed Postgres, per-service deploys, straightforward rollback                                                                                                                                                                           |

Versions are pinned in the manifests and verified by CI against the current stable releases.

---

## 5. Request lifecycle

```
Browser / PWA
   │  cookie: opaque session token (HTTP-only, Secure, SameSite=Lax)
   ▼
Fastify
   ├─ request-context      request id, structured log context
   ├─ helmet / cors        security headers, explicit origin allow-list
   ├─ rate-limit           keyed by organization when authenticated, IP otherwise
   ├─ authentication       session row → ActorContext (the ONLY source of identity)
   ├─ authorization        permission → actor type → entitlement
   └─ route handler
        ├─ Zod validation           shape only; never authorization
        ├─ idempotency claim        for every offline-capable mutation
        ├─ application service      business rules, transaction boundary
        │     └─ repository port → Prisma adapter → PostgreSQL
        └─ domain events            published after commit
```

Every step is refusable, and refusals are logged with the actor and route. A cross-tenant
refusal is logged at `warn` with a distinct code so a pattern of probing is visible without
reconstructing it from an access log.

---

## 6. Error handling

Errors are a typed vocabulary (`packages/domain/src/errors.ts`), each carrying a stable
machine-readable `code` and a developer-facing English `message`. Clients branch on the code and
render a translated string looked up from it — which is how business logic stays free of
user-facing text ([localization.md](localization.md)).

| Kind                   | HTTP | Used for                                     |
| ---------------------- | ---- | -------------------------------------------- |
| `VALIDATION`           | 400  | Malformed input                              |
| `UNAUTHENTICATED`      | 401  | No or invalid session                        |
| `FORBIDDEN`            | 403  | Permission or actor-type refusal             |
| `ENTITLEMENT_REQUIRED` | 403  | Plan does not include the feature            |
| `NOT_FOUND`            | 404  | Missing — **and every cross-tenant refusal** |
| `CONFLICT`             | 409  | Invariant violation, idempotency collision   |
| `PRECONDITION_FAILED`  | 422  | Valid input, wrong state                     |
| `RATE_LIMITED`         | 429  | Throttled or locked out                      |
| `INTERNAL`             | 500  | Bug                                          |

Cross-tenant access is deliberately reported as 404. Telling a caller "this exists but is not
yours" is itself the information leak we are preventing. The distinction survives internally so
the security event is logged accurately.

Nothing is ever swallowed. An unrecognized error is logged with its stack and request id before
a generic response goes out.

---

## 7. Time

Every timestamp is stored in UTC as `timestamptz`. Wall-clock rendering uses the site's IANA
timezone, falling back to the organization's.

Two consequences worth stating, because both are places people get this wrong:

- **Durations are measured between instants**, never by subtracting wall-clock times. A shift
  running 22:00–06:00 across a DST transition is 8 real hours, and the worker is paid for 8.
  Tested in `tests/unit/shift-duration.test.ts` for both transitions.
- **A shift belongs to the local calendar day it started on.** A night shift is one row on the
  evening it began, not two rows split across midnight
  ([reporting](../modules/reporting/src/domain/attendance.ts)).

---

## 8. The interface

`packages/ui` owns the white-label theming _plumbing_: semantic CSS custom properties derived from
`OrganizationBranding`, with WCAG contrast checking so a customer's brand colour can never produce
unreadable text. The primitives and the admin shell are built on top of it, so a tenant's branding
reaches every screen without a component knowing what colour it is.

`apps/web` is three real portals against the real API:

- **Worker** — clock in, change position, take a break, take a vehicle. Runs the tracking collector
  for the life of the shift.
- **Driver** — start and end a trip, with an optional route and planned distance. No pause control
  exists anywhere in it.
- **Admin** — dashboard, who is on shift, staff, history, zones and positions, fleet, trips, the
  live map, geofences and settings.

Two rules hold across all three, and both exist because breaking either produces a number somebody
would act on:

- **No screen computes a figure the server could compute.** Distance, duration, fuel, speed,
  staleness and every count come down the wire finished. A total a client can recompute is a total
  a client can change.
- **No timer runs off the device clock.** Every response that drives one carries `serverTime`, and
  the elapsed figures are offset from it — a phone an hour fast must not show an hour of work
  nobody did.

---

## 9. Development phases and current status

| Phase | Scope                                                                | Status                                     |
| ----- | -------------------------------------------------------------------- | ------------------------------------------ |
| 0     | Architecture and documentation                                       | **Done**                                   |
| 1     | Monorepo, database, migrations, API skeleton, CI                     | **Done**                                   |
| 2     | Auth, roles, sessions, multi-tenancy                                 | **Done**                                   |
| 3     | Markets, localization, currency, pricing catalogs                    | **Done**                                   |
| 4     | Plans, features, entitlements, BillingProvider seam                  | **Done**                                   |
| 5     | Sites, positions, workers, qualifications, shifts, position sessions | **Done**                                   |
| 6     | Worker portal API and offline contract                               | **Done** (API); UI awaits design           |
| 7     | Design implementation                                                | **Blocked — awaiting design reference**    |
| 8     | Offline engine (IndexedDB, sync queue)                               | Server contract done; client pending       |
| 9     | Production entries and templates                                     | Domain done; admin UI pending              |
| 10    | Admin dashboard                                                      | Awaiting design                            |
| 11    | Driver portal                                                        | **Done** (API); UI awaits design           |
| 12    | Fleet                                                                | Domain and schema done; admin UI pending   |
| 13    | GPS integrity                                                        | **Done**                                   |
| 14    | Reporting                                                            | Attendance done; remaining reports pending |
| 15    | Recommendations                                                      | Domain done; UI pending                    |
| 16    | Audit and observability                                              | **Done**                                   |
| 17    | SaaS onboarding                                                      | Pending                                    |
| 18    | Production billing (Stripe)                                          | Seam done; adapter pending                 |
| 19    | Production hardening                                                 | Pending                                    |

---

## 10. Risks and tradeoffs

Stated plainly, because each is a decision someone will want to revisit.

**Permissions are snapshotted onto the session.**
Authorization is a single indexed read instead of a role join per request. The cost: a
permission change must revoke the affected sessions, and `SessionService.revokeForActor` is the
path that must not be forgotten. Reviewed on every change to roles or membership.

**RLS does not constrain the migration/owner role.**
In production the application connects as a non-owner role and the policies bite; against the
owner (local development, migrations) they are inert. This is why RLS is defense in depth and
the application-layer tenant filter is the primary control. Making RLS primary would mean
`FORCE ROW LEVEL SECURITY` and a GUC on every connection, which trades a real availability risk
for a marginal security gain.

**`withTenant` costs one extra statement per transaction.**
Setting the tenant GUC is a round trip. Accepted: it is what makes the RLS policies meaningful
on a pooled connection.

**Distance is deliberately under-reported.**
The GPS filters (accuracy, minimum segment, maximum speed, no gap bridging) reject noise at the
cost of losing some genuine short movements. Distance feeds fuel estimates and, in some
organizations, driver pay — over-reporting would be the worse failure.

**No FX conversion.**
Prices are authored per market in the currency billed. Cross-currency fleet reporting throws
rather than silently converting. A multi-currency fleet needs an explicit rate source and rate
date, which is a feature, not a default.

**US sales tax is not computed.**
`TaxService` returns `DEFERRED_TO_PROVIDER` for US customers. Nexus and rate sourcing belong to
Stripe Tax or Avalara; returning a wrong number would be worse than returning none.

**ro, pl and cs catalogs are partial.**
Declared, wired, and falling back to English per key, with `catalogCoverage()` reporting exactly
how complete each is. Shipping a half-guessed Polish interface as finished would be worse than a
readable English fallback. They need native review before those markets launch.

**Correcting a session boundary needs both rows.**
A supervisor can shrink a position session but cannot extend it into its neighbour — the guard
refuses overlapping history. Adjusting the boundary between two adjacent sessions is a distinct
command that does not exist yet. The refusal is correct today; the missing command is tracked
work.

**In-process event bus.**
Domain events are delivered in-process after commit. A handler that must not lose work needs an
outbox; the bus does not pretend to be durable, and `EventCollector` exists so events are
published after the transaction rather than inside it.

---

## Document map

| Topic                                 | Document                                           |
| ------------------------------------- | -------------------------------------------------- |
| Entity map, indexes, constraints      | [database.md](database.md)                         |
| Sessions, PINs, lockout, CSRF         | [authentication.md](authentication.md)             |
| Permissions, roles, guards            | [authorization.md](authorization.md)               |
| Tenant isolation, RLS                 | [multi-tenancy.md](multi-tenancy.md)               |
| Markets, pricing, tax                 | [market-pricing.md](market-pricing.md)             |
| Subscriptions, provider seam, VAT     | [billing.md](billing.md)                           |
| Locales, catalogs, formatting         | [localization.md](localization.md)                 |
| Branding, theming, uploads            | [white-label.md](white-label.md)                   |
| Module boundaries, adding a module    | [modular-architecture.md](modular-architecture.md) |
| Positions, eligibility, corrections   | [position-management.md](position-management.md)   |
| Drivers, vehicles, costs              | [driver-fleet.md](driver-fleet.md)                 |
| GPS arithmetic, states, privacy       | [tracking.md](tracking.md)                         |
| The tracking engine, sessions, fences | [workforce-tracking.md](workforce-tracking.md)     |
| Offline queue, idempotency            | [offline-sync.md](offline-sync.md)                 |
| Customer feedback to roadmap          | [recommendations.md](recommendations.md)           |
| Endpoints and conventions             | [api.md](api.md)                                   |
| Railway, migrations, backups          | [deployment.md](deployment.md)                     |
| Decision records                      | [decisions/](decisions/)                           |
