# Modular architecture

A new module must be addable without breaking unrelated modules. That sentence is the whole
design constraint; everything here follows from it.

---

## 1. Module anatomy

```
modules/<name>/
├── src/
│   ├── domain/          pure rules + repository PORTS (interfaces)
│   ├── application/     commands and queries; the transaction boundary
│   ├── infrastructure/  Prisma implementations of the ports
│   ├── api/             route definitions (optional; some modules are consumed, not exposed)
│   ├── validation/      module-specific schemas
│   └── index.ts         the ONLY public surface
└── package.json
```

### The layer rule

| Layer             | May import                                      | Must not import                              |
| ----------------- | ----------------------------------------------- | -------------------------------------------- |
| `domain/`         | `@aytracker/{types, domain}`                    | Prisma, database, HTTP, React, other modules |
| `application/`    | its own domain, other modules' **public index** | Prisma, database, HTTP, React                |
| `infrastructure/` | its own domain, `@aytracker/database`           | HTTP, React                                  |
| `api/`            | anything in the module, Fastify                 | another module's internals                   |

Machine-enforced in `eslint.config.js`:

```js
{
  files: ['modules/*/src/domain/**/*.ts', 'modules/*/src/application/**/*.ts'],
  rules: { 'no-restricted-imports': ['error', { paths: [
    { name: '@prisma/client', message: 'Depend on a repository port; wire the adapter in infrastructure/.' },
    { name: '@aytracker/database', message: '…' },
  ]}]},
}
```

This is not a style preference. It is what makes the domain testable without a database, and
what keeps a schema change from rippling into business rules.

---

## 2. How modules talk to each other

Three mechanisms, in order of preference.

### a) A published query service — synchronous, when an answer is needed now

`shifts` needs to know whether a worker may occupy a position. It calls the service `workforce`
publishes:

```ts
const decision = await this.workforce.checkEligibility({
  organizationId,
  workerId,
  positionId,
  now,
});
```

`shifts` does **not** query workforce tables. It does not know what a qualification row looks
like. When the eligibility rules change, `shifts` does not recompile.

### b) A port the consumer defines — inverted, when the consumer owns the contract

`drivers` needs a driver's assigned vehicle, which lives in fleet's tables. Rather than importing
`fleet`, `drivers` declares what it needs:

```ts
// modules/drivers/src/domain/ports.ts
export interface DriverVehicleAccess {
  currentVehicleId(organizationId: OrganizationId, driverId: DriverId): Promise<VehicleId | null>;
  recordOdometer(input: { organizationId; vehicleId; odometer }): Promise<void>;
}
```

The adapter that satisfies it lives in `drivers/infrastructure` and is allowed to know about
vehicles. `drivers` has no dependency on `fleet` at all — which is why `fleet` can depend on
`drivers` without a cycle.

### c) Domain events — asynchronous, when the producer should not care who listens

```ts
await this.events.publish({
  name: 'shift.completed',
  organizationId,
  occurredAt,
  payload: { shiftId, workerId, workedSeconds, breakSeconds },
});
```

`reporting` and `audit` subscribe. `shifts` has never heard of either. Adding a fourth consumer
is a subscription, not an edit to `shifts`.

Events are published **after** the transaction commits — `EventCollector` gathers them inside and
the application service flushes them after. Publishing mid-transaction would let a subscriber
observe state that later rolls back.

A handler that throws is logged and does not fail the producing command. The bus does not pretend
to be durable: a subscriber that must not lose work needs an outbox.

---

## 3. The dependency graph

```
audit  reporting            (consumers — subscribe to events, depended on by nobody)
   ▲       ▲
   │       │  events
   │       │
production ──► shifts ──► workforce
                             ▲
   fleet ──► drivers ────────┘ (via a port drivers defines)

recommendations                (independent)
```

No cycles. Enforced by review plus the deep-import lint rule; a genuine cycle would also fail the
Turborepo build, since a package cannot build before its dependency.

---

## 4. Adding a module

Worked example: a `quality` module recording defect inspections.

**1. Scaffold**

```
modules/quality/src/{domain,application,infrastructure,api,validation}/
modules/quality/package.json     name: @aytracker/module-quality
```

**2. Domain** — pure rules and ports.

```ts
// domain/inspection.ts
export function assertValidInspection(input: InspectionInput): void { … }

// domain/ports.ts
export interface InspectionRepository {
  create(input: { organizationId: OrganizationId; … }): Promise<Inspection>;
}
```

**3. Migration** — new tables with `organizationId`, tenant indexes, `UNIQUE (organizationId, id)`
if anything will reference them, composite `*_same_tenant` foreign keys, and an entry in the RLS
table list ([multi-tenancy.md](multi-tenancy.md) § 6).

**4. Permissions** — add to `PERMISSIONS` and to the system roles that should hold them.

```ts
QUALITY_READ: 'quality.read',
QUALITY_CREATE: 'quality.create',
```

**5. Entitlement** — add a `Feature` row and attach it to the plans that include it.

```ts
{ code: 'quality', name: 'Quality', moduleCode: 'quality' }
```

**6. Routes**

```ts
app.post(
  '/inspections',
  {
    preHandler: [
      app.requireActorType(['USER']),
      app.requirePermission(PERMISSIONS.QUALITY_CREATE),
      app.requireEntitlement(FEATURES.QUALITY),
    ],
  },
  handler,
);
```

**7. Wire it** in `apps/api/src/services/container.ts` and register the routes in `app.ts`.

**8. Tests** — domain unit tests, plus an entry in the tenant-isolation suite.

**9. Feature flag** (optional) for a gradual rollout.

**What you do not touch:** any other module. If adding `quality` requires editing `shifts`, the
boundary is wrong — the usual fix is that `shifts` should be publishing an event `quality`
subscribes to.

---

## 5. Shared packages vs. modules

|                | Package                                     | Module                         |
| -------------- | ------------------------------------------- | ------------------------------ |
| Contains       | Cross-cutting mechanism                     | Business capability            |
| Examples       | money, time, permissions, tracking geometry | shifts, fleet, reporting       |
| Owns tables    | No                                          | Yes                            |
| Depended on by | Many modules                                | Rarely, and only via its index |

The test: **would two unrelated modules both need this?** Money arithmetic — yes, a package.
Shift-duration rules — no, that is the shifts module.

`@aytracker/tracking` is a package rather than part of `drivers` because fleet reporting and
future telematics integrations need the same geometry and fuel arithmetic.

---

## 6. Provider abstractions

Every external system sits behind an interface owned by this codebase:

| Interface         | Default                                 | Why abstracted                                              |
| ----------------- | --------------------------------------- | ----------------------------------------------------------- |
| `BillingProvider` | `UnconfiguredBillingProvider` (throws)  | Provider replaceable without rewriting billing              |
| `RoutingProvider` | `HaversineRoutingProvider` (no network) | Route history keeps working when a vendor is down or unpaid |
| `EventBus`        | `InProcessEventBus`                     | A queue can replace it without touching producers           |
| `AuditSink`       | Prisma writer                           | Audit can be shipped elsewhere                              |

Integrations follow the same shape:

```
External system → Integration adapter → Application command → Domain → Database
```

An external system never touches a table directly. It goes through the same commands and the same
validation as a human, which is why an import cannot create a state the UI could not.
