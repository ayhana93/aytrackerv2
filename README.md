# AYtracker v2

Multi-tenant B2B SaaS for manufacturing and operational companies. Tracks who worked where and
for how long, what they produced, and what the vehicles serving the operation cost to run.

Not an ERP. The architecture is built so that adding a module never requires it to become one.

---

## Quick start

Requires **Node 22+**, **pnpm 10+**, and Docker (or your own PostgreSQL 16).

```bash
pnpm install
pnpm setup      # database, .env.local with a generated secret, migrations, seed
pnpm dev        # api → :3001   web → :3000
```

`pnpm setup` is safe to re-run: it creates what is missing and never overwrites an existing
`.env.local`. Already running PostgreSQL yourself? `./scripts/setup.sh --no-docker`.

Then open:

| Portal | URL                                |
| ------ | ---------------------------------- |
| Worker | http://localhost:3000/worker       |
| Driver | http://localhost:3000/driver       |
| Admin  | http://localhost:3000/admin        |
| Health | http://localhost:3001/health/ready |

### Demo credentials

Printed by the seed. By default:

```
Admin    admin@demo-factory.example / demo-password-2026!
Worker   employee 1001 / PIN 482913   (organization: demo-factory)
Driver   driver D001 / PIN 571364     (organization: demo-factory)
```

Override with `SEED_ADMIN_PASSWORD`, `SEED_WORKER_PIN`, `SEED_DRIVER_PIN`.
`SEED_DEMO=false` seeds only platform reference data — what production runs.

Worker 1001 (Иван) is linked to driver D001, so the worker portal shows the **Шофьор** position:
selecting it offers a vehicle and hands off to the driver portal with a trip recording. See
[docs/driving-handoff.md](docs/driving-handoff.md).

### Configuration

One `.env.local` at the repository root, read by the API, the web app and every database command.
`.env.example` documents every setting; an empty value means "not set".

`SESSION_SECRET` is the only one you must supply, and `pnpm setup` generates it. In production
every value comes from the platform's environment — a file is never deployed.

### Doing it by hand

```bash
docker compose up -d postgres        # or use your own PostgreSQL 16
cp .env.example .env.local
sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -base64 48)|" .env.local
pnpm db:migrate:deploy
pnpm db:seed
pnpm dev
```

---

## Commands

```bash
pnpm setup              # from a fresh clone to a running application
pnpm build              # turbo build, all packages
pnpm dev                # api + web in watch mode

pnpm db:up              # start PostgreSQL in Docker
pnpm db:down            # stop it (the volume, and your data, survive)
pnpm db:logs
pnpm lint               # eslint, including the architectural import rules
pnpm typecheck
pnpm test               # unit tests (fast, no database)
pnpm test:integration   # needs TEST_DATABASE_URL
pnpm verify             # format + lint + typecheck + unit tests

pnpm db:migrate         # create and apply a migration (development)
pnpm db:migrate:deploy  # apply only (CI/production)
pnpm db:seed
pnpm db:studio
```

Integration tests run against a real database — the invariants they check (partial unique
indexes, composite tenant foreign keys, transaction atomicity) do not exist in a mock.
`docker compose` creates `aytracker_test` on first boot:

```bash
export TEST_DATABASE_URL="postgresql://aytracker:aytracker@localhost:5432/aytracker_test?schema=public"
DATABASE_URL=$TEST_DATABASE_URL pnpm db:migrate:deploy
pnpm test:integration
```

---

## Structure

```
apps/web         Next.js — admin, worker and driver portals
apps/api         Fastify — the only writer of business state
packages/*       types, config, domain, validation, auth, localization,
                 market, billing, tracking, database, ui
modules/*        workforce, shifts, production, reporting,
                 drivers, fleet, recommendations, audit
tests/           unit, integration, e2e
docs/            architecture and decision records
```

Dependency direction is enforced by ESLint, not convention:

```
apps → modules → database → {auth, market, billing, tracking, localization}
     → {domain, validation} → {types, config}
```

---

## The five rules

1. **The server is the source of truth.** No worker id, organization id, role, permission, price,
   market, duration, or GPS history is ever taken from a client.
2. **Tenant isolation is enforced three times** — application, authorization, database. The
   database layer uses composite `(organizationId, id)` foreign keys, so a cross-tenant reference
   is impossible rather than unlikely.
3. **Business logic lives in domain and application services.** React renders; it does not decide.
4. **Critical operations are atomic**, with a database constraint deciding any race the
   application check could lose.
5. **A module is added, never woven in.** New module = code + migration + permissions +
   entitlements + routes + tests. Never an edit to an unrelated module.

Start with [docs/architecture.md](docs/architecture.md).

---

## Status

Runs end to end: worker and driver portals, admin dashboard, fleet and white-label settings, on a
Fastify API and a PostgreSQL schema whose invariants are enforced by the database rather than by
convention.

Built: architecture, monorepo, database with its invariants, auth and multi-tenancy, markets and
pricing, entitlements, the core manufacturing domain, worker and driver portal APIs, GPS
integrity, audit, the design system in light and dark, and the worker → driver handoff.

### One thing worth knowing before you promise it

**A web app cannot record GPS while the phone is locked and the screen is off.** No API, no
service worker and no manifest flag changes that. The driver portal detects what the device can
actually do and says so before a trip starts, rather than implying a guarantee the platform will
not keep.

Delivering it for real needs a native wrapper — Capacitor with a background-location plugin, iOS
"Always" authorization, an Android foreground service. The complete configuration is written up in
[docs/tracking-client.md](docs/tracking-client.md); the collector is already behind a port, so the
driver screen does not change when it arrives.

Either way, silence is reported as a neutral tracking gap. It is never presented as a driver
having switched tracking off, because from the server a tunnel, a flat battery and a force-quit
are the same thing.

Full phase table: [docs/architecture.md](docs/architecture.md) § 9.
Known limitations and tradeoffs: [docs/architecture.md](docs/architecture.md) § 10.

---

## Tests

```
pnpm test              unit, no database, ~2s
pnpm test:integration  against real PostgreSQL
pnpm verify            format + lint + typecheck + unit
```

```
unit          shift duration incl. both DST transitions, eligibility precedence,
              position-session planning, market resolution, pricing and grandfathering,
              EU VAT and reverse charge, GPS distance and gap detection, fuel arithmetic,
              authorization, money, timezones, localization, the driving rules,
              boot configuration, and the design tokens (every CSS variable defined,
              contrast at AA in both themes, a brand reaching only the accent)

integration   tenant isolation against a real database, position-change atomicity under
              concurrency, the driving handoff as one transaction, HTTP security
              (permission gates, driver trip isolation, CSRF, session expiry, idempotent
              replay), and the schema invariants themselves — so a future migration that
              drops a partial unique index or an RLS policy fails the suite
```

---

## Documentation

| Topic                               | Document                                                |
| ----------------------------------- | ------------------------------------------------------- |
| Overview and decisions              | [architecture.md](docs/architecture.md)                 |
| Entities, indexes, constraints      | [database.md](docs/database.md)                         |
| Sessions, PINs, CSRF                | [authentication.md](docs/authentication.md)             |
| Permissions and guards              | [authorization.md](docs/authorization.md)               |
| Tenant isolation and RLS            | [multi-tenancy.md](docs/multi-tenancy.md)               |
| Markets, pricing, tax               | [market-pricing.md](docs/market-pricing.md)             |
| Subscriptions and the provider seam | [billing.md](docs/billing.md)                           |
| Locales and formatting              | [localization.md](docs/localization.md)                 |
| Branding and theming                | [white-label.md](docs/white-label.md)                   |
| Module boundaries                   | [modular-architecture.md](docs/modular-architecture.md) |
| Positions and eligibility           | [position-management.md](docs/position-management.md)   |
| Drivers, vehicles, costs            | [driver-fleet.md](docs/driver-fleet.md)                 |
| GPS, tracking states, privacy       | [tracking.md](docs/tracking.md)                         |
| Offline queue and idempotency       | [offline-sync.md](docs/offline-sync.md)                 |
| Customer feedback                   | [recommendations.md](docs/recommendations.md)           |
| Worker → driver handoff             | [driving-handoff.md](docs/driving-handoff.md)           |
| Recording on the device             | [tracking-client.md](docs/tracking-client.md)           |
| Endpoints                           | [api.md](docs/api.md)                                   |
| Railway, migrations, backups        | [deployment.md](docs/deployment.md)                     |
| Decision records                    | [decisions/](docs/decisions/)                           |
