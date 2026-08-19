# Multi-tenancy

Every company is an organization. Organization A must never see organization B's data, and the
system is built so that three independent mechanisms would each have to fail for that to happen.

---

## 1. The three layers

### Layer 1 — Application

Every repository method takes an explicit `organizationId`. There is no ambient "current tenant"
a repository could read, which means a caller that forgets the tenant does not compile:

```ts
findById(organizationId: OrganizationId, workerId: WorkerId): Promise<WorkerSummary | null>;
```

The `organizationId` comes from `ActorContext`, which is reconstructed from the session row. It
cannot come from a request body, header, or query parameter — there is no code path that reads
it from one.

Branded types (`packages/types/src/ids.ts`) make the common confusion a compile error:

```ts
export type OrganizationId = Brand<string, 'OrganizationId'>;
export type WorkerId = Brand<string, 'WorkerId'>;
```

Passing a `WorkerId` where an `OrganizationId` is expected does not typecheck. This costs
nothing at runtime and catches the single most expensive class of multi-tenant bug.

### Layer 2 — Authorization

`assertSameTenant(actor, resourceOrganizationId)` guards any resource loaded by id before it is
returned or mutated. It raises `FORBIDDEN` internally; the HTTP layer downgrades it to **404**,
because confirming that a row exists in another tenant is itself the leak.

Self-service actors get a second, narrower check: `assertOwnWorker` and `assertOwnDriver`. A
worker session may only act on its own worker record, a driver only on its own trips — inside
the right tenant is necessary but not sufficient.

### Layer 3 — Database

Two mechanisms, both in `migrations/20260819153000_invariants_and_rls/`.

#### Composite tenant foreign keys

Every parent table carries `UNIQUE (organizationId, id)`. Every child references the **pair**:

```sql
ALTER TABLE "shifts"
  ADD CONSTRAINT "shifts_site_same_tenant"
    FOREIGN KEY ("organizationId", "siteId")
    REFERENCES "sites" ("organizationId", "id");
```

A shift in organization A cannot reference a site in organization B. Not by convention — the
insert fails. There are 36 such constraints covering every cross-entity reference in the schema,
and `tests/integration/tenant-isolation.test.ts` proves each category.

`MATCH SIMPLE` (the default) means a NULL in any FK column skips the check, which is exactly
what optional relations need.

#### Row Level Security

RLS is enabled on 35 tenant tables with policies keyed on a session GUC:

```sql
CREATE POLICY "shifts_tenant_isolation" ON "shifts"
  USING ("organizationId" = aytracker_current_org())
  WITH CHECK ("organizationId" = aytracker_current_org());
```

The GUC is set per transaction by `withTenant()`:

```ts
await client.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
  return fn(tx);
});
```

`SET LOCAL` semantics (the `true` third argument) scope the setting to the transaction. On a
pooled connection this matters enormously: without it, one request's tenant would leak into the
next request that reuses the connection — which would make RLS worse than no RLS.

---

## 2. What RLS does and does not do here

**It is defense in depth, not the primary control.** Stated plainly because the distinction
determines how much you should trust it.

PostgreSQL does not apply RLS to a table's owner unless `FORCE ROW LEVEL SECURITY` is set. The
deployment model is:

| Connection                  | Role                       | Subject to RLS |
| --------------------------- | -------------------------- | -------------- |
| Application (production)    | `aytracker_app`, non-owner | **Yes**        |
| Migrations                  | owner                      | No             |
| Local development (default) | owner                      | No             |

So in production the policies bite; against the owner they are inert. Enabling `FORCE` would
make the policies apply to the owner too — and would immediately break any code path that
forgot to set the GUC, including migrations and maintenance scripts. That trades a real
availability risk for a marginal security gain over controls that are already doing the work.

### Production setup

```sql
CREATE ROLE aytracker_app LOGIN PASSWORD '<secret>';
GRANT CONNECT ON DATABASE aytracker TO aytracker_app;
GRANT USAGE ON SCHEMA public TO aytracker_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aytracker_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aytracker_app;
```

`DATABASE_URL` uses `aytracker_app`. Migrations run with a separate owner URL, supplied only to
the migration step.

---

## 3. Which tables are tenant-owned

**Tenant-owned** (carry `organizationId`, covered by RLS): everything under organizations,
workforce, shifts, production, drivers, fleet, tracking, recommendations, audit, corrections,
entitlements, billing customers, subscriptions, and the idempotency ledger.

**Platform-global** (deliberately not tenant-owned):

| Table                                                     | Why                                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `users`                                                   | One person may be a member of several organizations                    |
| `markets`, `plans`, `features`, `plan_features`, `prices` | Shared commercial catalog                                              |
| `feature_flags`                                           | Operational switches, per-organization targeting inside the row        |
| `roadmap_items`                                           | Several customers can request the same thing and see the shared status |
| `auth_attempts`                                           | Includes attempts against organizations that do not exist              |

`roles` is a hybrid: system roles have `organizationId = NULL` and are readable by every tenant;
custom roles belong to one organization. Its RLS policy encodes exactly that.

---

## 4. The organization boundary in practice

### Worker and driver login

Scoped by organization slug. The same employee number in two tenants is two different people,
and a PIN grinder has to know which tenant they are attacking. The slug is a lookup key, never
an authorization claim — the session's `organizationId` is set from the resolved organization
row, not from the submitted slug.

### QR codes

A position QR token is globally unique, but `findByQrToken` still filters by tenant. Scanning
another company's physical machine code reads as "not recognized", never as a position.

### Platform administrators

`User.isPlatformAdmin` allows support staff to act inside a tenant. Every such action is audited
with `isPlatformAdmin: true` on the actor. A platform admin session without a selected tenant has
`organizationId = null` and can reach no tenant-scoped route.

---

## 5. Testing

`tests/integration/tenant-isolation.test.ts` builds **two structurally identical tenants** and
asserts that every read returns the right one — not merely that it returns something. Identical
fixtures are the point: a test with different data in each tenant can pass by accident.

Proven there:

- A repository read scoped to A never returns B's worker or position.
- A QR token from B does not resolve inside A.
- The eligibility service refuses a position from another tenant.
- The position picker offers only the caller's own positions.
- The database refuses a shift referencing another tenant's site.
- The database refuses a position session referencing another tenant's position.
- The database refuses a trip pairing A's driver with B's vehicle.
- The database refuses a fuel expense against another tenant's vehicle.

Plus, at the HTTP level in `api-security.test.ts`: a worker logging in against another
organization's slug receives that organization's session, never the first one's.

---

## 6. Adding a tenant-owned table

1. Add `organizationId String` and the relation to `Organization`.
2. Index it: `@@index([organizationId, <the column you filter by>])`.
3. If other tables will reference it, add `UNIQUE (organizationId, id)` in a migration.
4. For every foreign key it holds, add the composite `*_same_tenant` constraint.
5. Add it to the `tenant_tables` array in a new RLS migration.
6. Give its repository methods an explicit `organizationId` first parameter.
7. Add it to the isolation test.

Step 7 is not optional. Every table added without one is a table nobody has proven is isolated.
