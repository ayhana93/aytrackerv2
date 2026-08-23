# Database

PostgreSQL 16, Prisma 6. Schema at `packages/database/prisma/schema.prisma`; the invariants
Prisma cannot express live in `migrations/20260819153000_invariants_and_rls/migration.sql`.

---

## 1. Conventions

| Convention                                               | Rationale                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `String @id @default(uuid(7))`                           | Time-ordered UUIDs: random enough not to be guessable, sequential enough that B-tree inserts stay local |
| `@db.Timestamptz(6)` everywhere                          | UTC storage; no naive timestamps anywhere in the schema                                                 |
| `Decimal(14,4)` for money, always with a currency column | Money is never a float                                                                                  |
| `Decimal(9,6)` for coordinates                           | ~0.11 m — more precision than consumer GPS provides is a privacy cost with no benefit                   |
| Tables `snake_case` via `@@map`, columns camelCase       | Prisma idiom; raw SQL quotes the camelCase columns                                                      |
| Every tenant index starts with `organizationId`          | Every tenant-scoped query filters on it first                                                           |

---

## 2. Entity map

### Platform (not tenant-owned)

```
Market ──< Price >── Plan ──< PlanFeature >── Feature
                                                 │
User                                     OrganizationEntitlement
FeatureFlag                                      │
RoadmapItem                                 Organization
```

### Tenant core

```
Organization ─┬─ OrganizationBranding   (1:1)
              ├─ OrganizationSettings   (1:1)
              ├─ BillingCustomer        (1:1)
              ├─< OrganizationMember >── User
              │        └── Role
              ├─< Subscription ── Plan, Price
              ├─< OrganizationEntitlement ── Feature
              └─< Site
```

### Workforce and shifts

```
Site ──< WorkArea ──< Position ──< PositionQualification >── Qualification
                          │                                        │
                          │                          WorkerQualification
                          │                                        │
                          └──< WorkerPositionEligibility >──── Worker
                                                                   │
ShiftType ──< Shift >───────────────────────────────────────────────┘
               ├──< ShiftBreak
               ├──< PositionSession ──< ProductionEntry >── ProductTemplate
               └────────────────────────────────────────────┘
```

### Drivers and fleet

```
Driver ─┬─< VehicleAssignment >── Vehicle ─┬─< VehicleExpense
        │                                  ├─< VehicleDocument
        └─< DriverTrip ────────────────────┘
                 ├──< TripLocationPoint
                 ├──< TrackingEvent
                 └──< FuelExpense
```

### Cross-cutting

```
AuditLog        who did what, when, from where — redacted, IP-truncated
Correction      immutable before/after snapshots of every historical edit
IdempotencyKey  one row per client action; makes offline replay safe
AuthAttempt     brute-force accounting, short retention
```

---

## 3. Invariants the schema language cannot express

### 3.1 Partial unique indexes — "at most one open X"

Application checks are necessary but not sufficient: two concurrent transactions both pass them.
These make the race lose at the database.

| Index                                        | Rule                                                    |
| -------------------------------------------- | ------------------------------------------------------- |
| `shifts_one_open_per_worker`                 | A worker has at most one shift in progress              |
| `shift_breaks_one_open_per_shift`            | A shift has at most one open break                      |
| `position_sessions_one_open_per_shift`       | **Never two open position sessions on one shift**       |
| `position_sessions_one_open_per_worker`      | A worker is open on at most one position, across shifts |
| `driver_trips_one_open_per_driver`           | A driver runs at most one trip                          |
| `driver_trips_one_open_per_vehicle`          | A vehicle is on at most one trip                        |
| `vehicle_assignments_one_open_per_vehicle`   | A vehicle has one open assignment                       |
| `vehicle_assignments_one_open_per_driver`    | A driver holds one vehicle                              |
| `prices_one_active_per_market_plan_interval` | One non-promotional active price per slot               |
| `subscriptions_one_live_per_org`             | One live subscription per organization                  |

```sql
CREATE UNIQUE INDEX "position_sessions_one_open_per_shift"
  ON "position_sessions" ("shiftId")
  WHERE "endedAt" IS NULL;
```

Relaxing one of these is a deliberate act — which is the point. A future shared-vehicle workflow
has to drop `vehicle_assignments_one_open_per_vehicle` explicitly, making the decision visible
rather than accidental.

### 3.2 Check constraints

29 of them. The ones that matter most:

```sql
-- Intervals cannot be inverted
CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt")     -- sessions, breaks
CHECK ("actualEnd" IS NULL OR "actualStart" IS NOT NULL)  -- a shift cannot end without starting

-- Quantities and money
CHECK ("goodQuantity" >= 0 AND "defectQuantity" >= 0)
CHECK ("liters" > 0)
CHECK ("currency" ~ '^[A-Z]{3}$')
CHECK ("countryCode" ~ '^[A-Z]{2}$')

-- Coordinates
CHECK ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180)

-- Odometer only moves forward within a trip
CHECK ("endOdometer" IS NULL OR "startOdometer" IS NULL OR "endOdometer" >= "startOdometer")

-- A session belongs to exactly one actor of its declared type
CHECK (
  ("actorType" = 'USER'   AND "userId"   IS NOT NULL AND "workerId" IS NULL AND "driverId" IS NULL)
  OR ("actorType" = 'WORKER' AND "workerId" IS NOT NULL AND "userId" IS NULL AND "driverId" IS NULL)
  OR ("actorType" = 'DRIVER' AND "driverId" IS NOT NULL AND "userId" IS NULL AND "workerId" IS NULL)
)
```

These hold regardless of which code path wrote the row — including a future import, a backfill,
or an integration adapter that has not been written yet.

### 3.3 Composite tenant foreign keys

See [multi-tenancy.md](multi-tenancy.md) § 1. 36 constraints; a child row can only reference a
parent in the same organization.

### 3.4 Row Level Security

35 tables, policies keyed on the `app.organization_id` GUC. Defense in depth — see
[multi-tenancy.md](multi-tenancy.md) § 2 for the honest scope.

---

## 4. Indexing

Every index that serves a tenant-scoped query leads with `organizationId`, so one B-tree serves
both the tenant filter and the secondary predicate.

| Access pattern               | Index                                                                       |
| ---------------------------- | --------------------------------------------------------------------------- |
| Worker's open shift          | `shifts (organizationId, workerId, status)`                                 |
| Shifts at a site in a period | `shifts (organizationId, siteId, scheduledStart)`                           |
| Position history of a shift  | `position_sessions (organizationId, shiftId, startedAt)`                    |
| Position utilization         | `position_sessions (organizationId, positionId, startedAt)`                 |
| Production for a period      | `production_entries (organizationId, recordedAt)`                           |
| Driver's trips               | `driver_trips (organizationId, driverId, startedAt)`                        |
| **Route reconstruction**     | `location_points (organizationId, tripId, timestamp)`                       |
| A session's own point stream | `location_points (organizationId, trackingSessionId, timestamp)` **unique** |
| Location retention sweep     | `location_points (organizationId, timestamp)`                               |
| Vehicle costs for a month    | `vehicle_expenses (organizationId, vehicleId, date)`                        |
| Expiring documents           | `vehicle_documents (organizationId, expiresAt)`                             |
| Session lookup               | `sessions (tokenHash)` unique                                               |
| Session expiry sweep         | `sessions (expiresAt)`                                                      |
| Audit trail for an entity    | `audit_logs (organizationId, entityType, entityId)`                         |

The session index is **unique**, not merely an index: one fix per session per instant. It replaced
the plain index of the same three columns rather than joining it, because two indexes on the same
shape would double the write cost of every ingested point and buy nothing. What it buys instead is
that a device queue re-sending a batch whose acknowledgement was lost — the ordinary consequence of
a bad connection — cannot store the same afternoon twice. See docs/offline-sync.md § 2.

### The one to watch

`location_points` is the highest-volume table by an order of magnitude. Sizing at the
target scale (100 active drivers, 8 h/day, 20 s sampling):

```
100 drivers × 8 h × 180 points/h ≈ 144 000 points/day ≈ 4.3 M/month
```

At roughly 120 bytes/row that is ~520 MB/month of table plus index. This is the reason for:

- **Adaptive sampling** — the device sends far fewer points when stationary or on low battery.
- **Server-side admission control** — points arriving faster than the configured floor are
  dropped, not stored.
- **Retention** — raw points are _intended_ to be kept 180 days and trip summaries 5 years, so
  that deleting the coordinates does not invalidate a year-old cost report. `deleteOlderThan` is
  written; nothing schedules it and no setting configures the window, so in practice points are
  kept indefinitely and the sizing above is a floor rather than a steady state. See
  docs/production-audit.md.

If volume outgrows a single table, the migration path is monthly range partitioning on
`timestamp` — the access pattern (always a trip within a time window) suits it, and the
retention sweep becomes a `DROP PARTITION` instead of a mass delete. Not done yet because
premature partitioning costs query planning complexity for no current benefit.

---

## 5. Migrations

```
edit schema.prisma
  → pnpm db:migrate           (creates and applies, dev)
  → review the generated SQL  ← not optional
  → pnpm test:integration
  → commit schema + migration together
  → pnpm db:migrate:deploy    (CI/production)
```

Rules:

- **Never** alter a production schema by hand.
- Review generated SQL before committing. Prisma will happily generate a destructive rename as
  a drop-and-create.
- Invariants that Prisma cannot express go in a hand-written migration alongside.
- Schema and migration are one commit. A schema change without its migration is a broken build
  for everyone else.

### Expand/contract for breaking changes

A column rename or type change is three deploys, not one:

1. **Expand** — add the new column, write to both, backfill.
2. **Migrate** — switch reads to the new column, deploy, verify.
3. **Contract** — drop the old column.

Skipping this means a window where the old and new application versions are both running against
one schema and one of them is wrong.

---

## 6. Error translation

`packages/database/src/errors.ts` maps constraint violations onto domain errors, so a lost race
surfaces as a meaningful conflict rather than a 500:

| Constraint                                 | Error                                                           |
| ------------------------------------------ | --------------------------------------------------------------- |
| `position_sessions_one_open_per_shift`     | `CONFLICT position.session_already_open`                        |
| `shifts_one_open_per_worker`               | `CONFLICT shift.already_active`                                 |
| `driver_trips_one_open_per_driver`         | `CONFLICT trip.already_active`                                  |
| `vehicle_assignments_one_open_per_vehicle` | `CONFLICT fleet.vehicle_already_assigned`                       |
| any `*_same_tenant`                        | `NOT_FOUND tenant.cross_reference` — logged as a security event |

An unrecognized database error is **not** translated. It propagates and is logged with its
stack; guessing at a mapping would hide a real bug.

---

## 7. Local development

```bash
createdb aytracker
export DATABASE_URL="postgresql://user:pass@localhost:5432/aytracker?schema=public"
pnpm db:migrate:deploy
pnpm db:seed
```

`pnpm db:seed` seeds platform reference data only — markets, plans, features, system roles —
which is what production runs. The demo organization is created only with `SEED_DEMO=true`:

```bash
SEED_DEMO=true pnpm db:seed   # adds the demo factory and prints its credentials
```

Opt-in rather than opt-out, deliberately. The guard used to be `NODE_ENV !== 'production'`,
which is unset often enough on a platform that builds and runs from one image that a seed run
against a live database fabricated a worker, five positions and three vehicles inside a real
customer's tenant.

Integration tests want their own database:

```bash
createdb aytracker_test
export TEST_DATABASE_URL="postgresql://user:pass@localhost:5432/aytracker_test?schema=public"
DATABASE_URL=$TEST_DATABASE_URL pnpm db:migrate:deploy
pnpm test:integration
```

Tests truncate between cases rather than re-migrating, which is the difference between a 40-second
suite and a 10-minute one.
