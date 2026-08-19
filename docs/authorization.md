# Authorization

One permission vocabulary. Roles are named bundles of permissions. **No code in this system
checks a role name** — code checks permissions, which is what makes a custom role possible
without touching business logic.

---

## 1. The three gates

Every protected route passes through up to three independent checks, in this order:

```
requireActorType   Is this the right kind of session?
requirePermission  Does this actor hold the permission?
requireEntitlement Has this organization paid for the feature?
```

Permission and entitlement are **deliberately separate**. A manager can hold `fleet.read` while
their organization is on a plan without fleet — the correct answer is "upgrade your plan", not
"you are forbidden". Conflating them produces the wrong message and the wrong upsell.

Actor type is separate again: a worker session must not reach an admin endpoint even if the
permission sets somehow overlapped. It is cheap and it closes a whole category of mistake.

---

## 2. The permission vocabulary

Defined once in `packages/auth/src/permissions.ts`. Adding a module means adding its codes here
and to the relevant system roles — nothing else changes.

### Organization and settings

```
organization.read      organization.update
settings.read          settings.update
users.manage           billing.manage
branding.read          branding.update
audit.read
```

### Workforce

```
workers.read     workers.create     workers.update     workers.delete
sites.read       sites.manage
positions.read   positions.manage
qualifications.read  qualifications.manage
```

### Shifts and production

```
shifts.read      shifts.create      shifts.update      shifts.delete
shifts.correct        ← editing historical shifts, breaks and position sessions
production.read  production.create  production.update
reports.read     reports.export
```

### Worker self-service — held only by a WORKER session

```
worker.portal.access      worker.shift.start        worker.shift.end
worker.break.manage       worker.position.change    worker.production.record
worker.history.read
```

### Drivers and fleet

```
drivers.read     drivers.manage

driver.portal.access   driver.trip.start    driver.trip.pause    driver.trip.stop
driver.location.submit driver.trip.history  driver.vehicle.view

fleet.read       fleet.create       fleet.update       fleet.delete
fleet.assign     fleet.tracking.read
fleet.expenses.read  fleet.expenses.create  fleet.documents.manage
```

### Recommendations

```
recommendations.create   recommendations.read
```

`assertKnownPermissions` rejects any code outside this list when an organization edits a custom
role, so a typo cannot silently create a permission that nothing grants and nothing checks.

---

## 3. System roles

Seeded once, immutable, shared by every tenant. Support needs a fixed reference point when a
customer asks "why can my supervisor do X".

| Role         | Actor  | Summary                                     |
| ------------ | ------ | ------------------------------------------- |
| `owner`      | USER   | Everything, including billing               |
| `admin`      | USER   | Everything except billing                   |
| `manager`    | USER   | Workforce, fleet, reporting, exports, audit |
| `supervisor` | USER   | Runs the floor; **holds `shifts.correct`**  |
| `viewer`     | USER   | Read-only                                   |
| `worker`     | WORKER | `worker.*` only                             |
| `driver`     | DRIVER | `driver.*` only                             |

Organizations may create custom roles from the same vocabulary. They cannot edit system roles.

### The worker and driver roles are asserted, not assumed

```ts
it('gives a worker only worker.* permissions', () => {
  const permissions = systemRole(SYSTEM_ROLES.WORKER).permissions;
  expect(permissions.every((p) => p.startsWith('worker.'))).toBe(true);
  expect(permissions).not.toContain(PERMISSIONS.WORKERS_READ);
  expect(permissions).not.toContain(PERMISSIONS.SHIFTS_CORRECT);
});
```

If an admin permission ever leaks into the worker role, every worker in every tenant gains it at
once. That is worth a test rather than a convention.

The converse is tested too: no USER role carries a `worker.*` or `driver.*` permission.

---

## 4. Self-service scoping

Holding `worker.position.change` says a worker may change _their own_ position. The second check
says which worker:

```ts
assertOwnWorker(actor, workerId); // WORKER session, and actor.workerId === workerId
assertOwnDriver(actor, driverId); // DRIVER session, and actor.driverId === driverId
```

In practice the routes go further and never accept an id at all — the worker or driver comes
from the session, so there is nothing to compare. `assertOwnWorker` exists for the paths where an
id does appear (a supervisor acting on a worker, for instance) and as a guard against a future
route that adds one.

Driver trip reads take this further still: the driver filter is part of the **query**, not a
check afterwards.

```ts
where: { id: tripId, organizationId: actor.organizationId, driverId: actor.driverId }
```

Another driver's trip is simply not found. A 403 would confirm the id exists.

---

## 5. Route composition

```ts
app.get(
  '/fleet/vehicles',
  {
    preHandler: [
      app.requireActorType(['USER']),
      app.requirePermission(PERMISSIONS.FLEET_READ),
      app.requireEntitlement(FEATURES.FLEET_MANAGEMENT),
    ],
  },
  handler,
);
```

The requirement is visible at the route definition rather than buried in the handler, so a
reviewer can read a route file and see what it demands.

Portal-wide requirements are hooks:

```ts
app.addHook('preHandler', app.requireActorType(['DRIVER']));
app.addHook('preHandler', app.requireEntitlement(FEATURES.DRIVER_PORTAL));
```

---

## 6. Entitlements

```ts
entitlements.can('fleet.management');
entitlements.require('fleet.gps_tracking');
entitlements.requireCapacity('fleet.management', currentVehicleCount);
```

Plan checks are **never** scattered through the code. There is no `if (plan.tier === 'BUSINESS')`
anywhere, which is what makes a new plan a database row rather than a code change.

Resolution order:

1. A **market block** beats everything — regulatory carve-outs live on `Market.blockedFeatures`.
2. The entitlement row must exist and be enabled.
3. It must not have expired.
4. For metered features, usage must be under the limit.

Cached in-process for 60 s. An upgrade takes effect within a minute without anyone clearing a
cache, and `invalidate()` makes it immediate for the request that caused it.

### Feature flags are not entitlements

A flag answers "is this code path on"; an entitlement answers "has this customer paid for it".
Both must be true for a gated feature to run. Conflating them makes a kill switch impossible to
use during an incident, which is precisely when you need one.

`isInRollout` hashes the flag key together with the organization id, so a rollout is stable per
organization and two different flags at 10 % do not hit the same customers.

---

## 7. Platform administrators

`User.isPlatformAdmin` lets support act inside a tenant. Every action is audited with
`isPlatformAdmin: true` on the actor. A platform-admin session that has not selected a tenant has
`organizationId = null` and can reach no tenant-scoped route — enforced by a check constraint, not
only by application code.

---

## 8. Testing

`tests/unit/authorization.test.ts` (34 tests) covers the permission checks, role composition,
PIN policy, lockout back-off, session validation and entitlements.

`tests/integration/api-security.test.ts` (21 tests) proves the same rules through HTTP:

```
Worker cannot reach the driver portal            → 403 auth.wrong_actor_type
Driver cannot read another driver's trip         → 404 (not 403)
Driver's trip list contains only their own trips
Unauthenticated request to a portal              → 401
Expired session                                  → 401
Revoked session                                  → 401
Mutation without a CSRF header                   → 403 auth.csrf_failed
Position change to an ineligible position        → 403 position.qualification_required
```
