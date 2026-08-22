# Drivers and fleet

Two modules. `drivers` owns the portal and trips; `fleet` owns vehicles, assignments and costs.
`drivers` does not depend on `fleet` — see [modular-architecture.md](modular-architecture.md) § 2b.

---

## 1. Driver portal

Mobile-first. Drivers do **not** get the admin application.

```
LOGIN → ASSIGNED VEHICLE → START TRIP → GPS TRACKING
                                ↓
                     PAUSE / RESUME → END TRIP
```

A driver sees: their active trip, their assigned vehicle, route status, distance, duration,
current location while active, their own history, and fuel information where appropriate.

A driver never sees another driver's route. That is enforced by the query, not by a check
afterwards:

```ts
where: { id: tripId, organizationId: actor.organizationId, driverId: actor.driverId }
```

Another driver's trip is **not found**, not forbidden — a 403 would confirm the id exists.

### Permissions

```
driver.portal.access   driver.trip.start   driver.trip.stop
driver.location.submit driver.trip.history driver.vehicle.view
```

The driver system role contains these and nothing else; a test asserts every entry starts with
`driver.`. There is deliberately no `driver.trip.pause` — see § 2.

---

## 2. Trips

```
PLANNED ──► ACTIVE ──► COMPLETED
    └────────┴────────► CANCELLED
```

`PAUSED` is still in the enum and still handled by the arithmetic, because trips recorded before
pausing was removed carry it. Nothing a driver can do produces it any more: **a trip records from
the moment it starts until the driver ends it.** The pause control was the one way to keep the
vehicle moving with the record switched off, which put a hundred kilometres of fuel against no
trip; a stationary vehicle is already visible as a stop on its own track, without anyone pressing
anything.

**The vehicle is resolved server-side.** A driver who holds an assignment drives that vehicle,
whatever the request body says. A driver who holds none — the ordinary case for someone who signs
in at the driver door rather than arriving through the worker handoff — picks one from
`GET /driver/vehicles`, which lists only what is active and unheld. The assignment that creates
is marked automatic and is handed back when the trip ends; a fleet manager's standing assignment
is never touched.

**The route is optional.** `label` names it, `plannedDistanceKm` says how far it was expected to
go, and a trip with neither is an ordinary trip — the record of where it went is the track. A
planned distance without a label is refused: a number with no route attached cannot be checked
afterwards. When both are present the trip is measured against them.

Derived numbers are always server-computed:

```ts
{
  (distanceMeters, durationSeconds, pausedSeconds, untrackedSeconds);
}
```

`durationSeconds` is wall-clock minus paused time. `untrackedSeconds` is time the trip was running
with no location arriving ([tracking.md](tracking.md) § 5). Distance is recomputed from every
stored point at close.

Pause intervals on historical trips are reconstructed from the tracking-event log rather than a
separate table — the events are already the record, and a second table would be a second source
of truth to keep in sync.

### Fuel

An **estimate** and an **actual** are different numbers with different trust levels, and the
distinction is enforced in `estimateFuel` versus `calculateFuelTotal`.

The estimate needs two inputs and produces nothing without them: the vehicle's
`averageConsumption` gives litres, and the organization's `fuelPricePerLiter`
(`PATCH /admin/settings`) turns litres into money. Missing either yields `null` rather than a
zero — an absence and a claim of "free" are not the same thing, and a national average rendered
as this customer's cost would be an invented number wearing a currency symbol.

The unit price keeps its own precision until the multiplication is finished. A pump price has
three decimals and the settings column stores four; rounding it to the euro's two before
multiplying is rounding the wrong number, and the error scales with every litre.

Database guarantees: one active trip per driver, one per vehicle, both partial unique indexes.

Odometer only moves forward: a closing reading lower than the vehicle's current value is ignored,
because silently accepting a typo would corrupt every cost-per-km figure derived from it.

---

## 3. Vehicles

```
Vehicle
  registrationNumber, vin, make, model, year,
  vehicleType, fuelType, fuelTankCapacity,
  odometerCurrent, averageConsumption, consumptionUnit,
  status, notes
```

Types: `CAR VAN TRUCK BUS FORKLIFT OTHER`
Fuels: `PETROL DIESEL LPG CNG ELECTRIC HYBRID OTHER`

`consumptionUnit` supports `L_PER_100KM`, `MPG_US`, `MPG_UK`, `KWH_PER_100KM`, normalized by
`toLitersPer100Km` — so an imperial fleet and a metric one share one calculator.

Electric vehicles reuse the fuel model: "litres" are kWh and "price per litre" is price per kWh.
A parallel energy model would duplicate every cost roll-up for no analytical gain.

---

## 4. Assignments

```
VehicleAssignment: organizationId, driverId, vehicleId, startedAt, endedAt
```

One open assignment per vehicle **and** per driver, enforced by partial unique indexes.

A future shared-vehicle workflow has to drop those indexes deliberately — which is the point.
The constraint makes the decision visible rather than accidental.

Unassigning is refused while the driver has an active trip: it would orphan the trip's vehicle
reference and leave a driver tracking a vehicle they no longer hold.

---

## 5. Fuel: estimated versus actual

The distinction this module exists to protect.

|           | Estimated                              | Actual        |
| --------- | -------------------------------------- | ------------- |
| From      | Distance × average consumption × price | A receipt     |
| Stored in | Computed on read                       | `FuelExpense` |
| Trust     | A model                                | A fact        |

**An estimate never overwrites an actual.** They are stored separately and compared, never
merged.

```ts
estimateFuel({
  distanceMeters: 240_000,
  averageConsumption: 8,
  consumptionUnit: 'L_PER_100KM',
  pricePerLiter: '1.50',
  currency: 'EUR',
});
// → { liters: 19.2, cost: €28.80, isEstimate: true }
```

`isEstimate: true` is on the type so the value can never be mistaken for a real expense.

### The total is never trusted from the client

`FuelExpense` accepts litres and price per litre. The server computes
`totalCost = liters × pricePerLiter` with half-up rounding at the currency's minor unit. The
create schema has no `totalCost` field at all.

62.4 L × €1.49 = 92.976 → **€92.98**.

### Real consumption

`consumptionFromRefuels` computes brim-to-brim consumption between two full-tank refuels. Only
valid when both filled the tank, which is why `FuelExpense.isFullTank` exists.

`compareFuel` reports estimated versus actual with a variance percentage. A persistent positive
variance is a maintenance signal — or a stale average-consumption figure — which is exactly why
the estimate must survive alongside the receipt.

---

## 6. Vehicle costs

```
FUEL  INSURANCE  VIGNETTE  ROAD_TOLL  MAINTENANCE  REPAIR
TAX   INSPECTION PARKING   LEASING    FINE         OTHER
```

Adding a category is one enum value plus a migration. Nothing in the roll-up logic enumerates
categories by hand.

`summarizeVehicleCosts` returns per-category totals, a grand total, cost per km, and fuel cost per
km. Two decisions:

- **Fuel is counted once.** A `FuelExpense` links to its `VehicleExpense` row via
  `fuelExpenseId`, so the fuel detail and the cost roll-up cannot double-count.
- **Mixed currencies throw.** A fleet across a currency border needs an explicit FX decision with
  a rate date, not an invented number. `fleet.mixed_currency` is a refusal, not a silent
  conversion.

Cost per km returns **null** for zero distance, not zero. "No data" and "free" are different
claims.

---

## 7. Document expiration

Deliberately generic — insurance, inspections, vignettes, registrations, and later worker
qualifications all answer the same question.

```ts
type ExpirationSeverity = 'OK' | 'DUE_SOON' | 'CRITICAL' | 'EXPIRED';
```

`CRITICAL` inside 7 days; `DUE_SOON` inside the document's own `reminderDays`. `pendingExpirations`
returns everything needing attention, most urgent first.

```
⚠ Insurance expires in 12 days
⚠ Inspection expires in 5 days
```

Modelling it once means the notifications module, when it arrives, subscribes to one abstraction
rather than six.

---

## 8. Admin fleet panel

```
Fleet
├── Vehicles      registration, driver, odometer, fuel type, consumption
├── Drivers       status, assigned vehicle, active trip, tracking state
├── Assignments
├── Trips         route, distance, stops, tracking interruptions
├── Fuel          actual expenses, estimated comparison
├── Insurance / Vignettes / Maintenance / Documents
└── Costs         per category, per month, per km
```

Live driver status:

```
Ivan    🟢 Active               Maria   ⚠ Tracking interrupted
        Vehicle: CA1234AB               Vehicle: PB5678CD
        Trip: Sofia → Plovdiv           Last update: 14:32
        Tracking: Active
```

The domain and schema for all of this exist; the admin interface waits on the design reference.

---

## 9. Analytics

Centralized in `@aytracker/tracking` and `modules/fleet/domain/expenses.ts`:

```
fuel cost/km · total cost/km · consumption · distance by vehicle · distance by driver
trips by driver · idle time · tracking interruptions · monthly and yearly vehicle cost
```

One implementation each, so "cost per km" means the same number on the vehicle page, the monthly
report and the dashboard.

---

## 10. Tests

`tests/unit/tracking.test.ts` — fuel arithmetic, consumption conversion, cost per km.
`tests/integration/tenant-isolation.test.ts` — the database refuses A's driver with B's vehicle,
and a fuel expense against another tenant's vehicle.
`tests/integration/api-security.test.ts` — driver trip isolation reported as 404; a worker
session refused on a driver route.
