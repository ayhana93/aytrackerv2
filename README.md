# AYtracker v2

Multi-tenant B2B SaaS for manufacturing and operational companies. Tracks who worked where and
for how long, what they produced, and what the vehicles serving the operation cost to run.

Not an ERP. The architecture is built so that adding a module never requires it to become one.

---

## Quick start

Requires Node 22, pnpm 10, PostgreSQL 16.

```bash
pnpm install

createdb aytracker
cp .env.example .env.local
# set DATABASE_URL and SESSION_SECRET (openssl rand -base64 48)

pnpm db:migrate:deploy
pnpm db:seed          # prints demo credentials

pnpm dev              # api :3001, web :3000
```

### Demo credentials

Printed by the seed. By default:

```
Admin    admin@demo-factory.example / demo-password-2026!
Worker   employee 1001 / PIN 482913   (organization: demo-factory)
Driver   driver D001 / PIN 571364     (organization: demo-factory)
```

Override with `SEED_ADMIN_PASSWORD`, `SEED_WORKER_PIN`, `SEED_DRIVER_PIN`.
`SEED_DEMO=false` seeds only platform reference data — what production runs.

---

## Commands

```bash
pnpm build              # turbo build, all packages
pnpm dev                # api + web in watch mode
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

Integration tests want their own database:

```bash
createdb aytracker_test
export TEST_DATABASE_URL="postgresql://…/aytracker_test?schema=public"
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

Phases 0–6 and 11–13 are built: architecture, monorepo, database with its invariants, auth and
multi-tenancy, markets and pricing, entitlements, the core manufacturing domain, the worker and
driver portal APIs, GPS integrity, and audit.

**Phase 7 — design implementation — is blocked awaiting a design reference.**

The visual design of AYtracker has deliberately not been decided. `packages/ui` contains the
white-label theming plumbing (semantic tokens derived from `OrganizationBranding`, with WCAG
contrast checking); `apps/web` contains wireframe placeholders. Building a component library
before the reference arrives would be choosing the design by accident.

Full phase table: [docs/architecture.md](docs/architecture.md) § 9.
Known limitations and tradeoffs: [docs/architecture.md](docs/architecture.md) § 10.

---

## Tests

```
237 passing
├── 187 unit          shift duration incl. both DST transitions, eligibility precedence,
│                     position-session planning, market resolution, pricing and grandfathering,
│                     EU VAT and reverse charge, GPS distance and gap detection, fuel arithmetic,
│                     authorization, money, timezones, localization
└──  50 integration   tenant isolation against a real database, position-change atomicity under
                      concurrency, HTTP security (actor types, driver trip isolation, CSRF,
                      session expiry, idempotent replay)
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
| Endpoints                           | [api.md](docs/api.md)                                   |
| Railway, migrations, backups        | [deployment.md](docs/deployment.md)                     |
| Decision records                    | [decisions/](docs/decisions/)                           |
