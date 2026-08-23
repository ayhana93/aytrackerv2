# The worker → driver handoff

A worker taps "Шофьор", picks a vehicle, and is in the driver portal with a trip already
recording. This document is what happens underneath, and why each part is shaped the way it is.

Related: [position-management.md](./position-management.md) for position sessions in general,
[driver-fleet.md](./driver-fleet.md) for trips and vehicles, [tracking.md](./tracking.md) for the
server side of GPS, [tracking-client.md](./tracking-client.md) for the device side.

---

## 1. The flow

```
Worker portal                                     Server
─────────────                                     ──────
tap СМЕНИ ПОЗИЦИЯ
  │
  ├─ GET  /worker/positions ──────────────────►  eligible positions only,
  │                                               each carrying its kind
  │
tap "Шофьор"  (kind === 'DRIVING')
  │
  ├─ GET  /worker/positions/:id/vehicles ─────►  eligibility re-checked,
  │                                               then selectable vehicles
  │
pick a vehicle, confirm
  │
  └─ POST /worker/driving/begin ──────────────►  ONE TRANSACTION:
                                                   close current position session
                                                   open session on the driving position
                                                   assign the vehicle (or reuse)
                                                   open a trip, linked to that session
                                                 then, after commit:
                                                   elevate the session
                                                   publish driving.started
  ◄──────────────────────── { tripId, redirectTo: '/driver', ... }
navigate to /driver, start the collector
```

The reverse happens on its own. Changing to any other position, or ending the shift, closes the
trip, releases the vehicle if this flow assigned it, and strips the driving permissions back off
the session. The driver never has to remember to end anything.

---

## 2. Why it is one transaction

Three facts have to become true together: the worker is on the driving position, the vehicle is
theirs, and a trip is open. Any two without the third is a state that quietly corrupts numbers
downstream:

| Half-applied state            | What breaks                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Session moved, no trip        | The driver is "driving" with no route recorded. Distance and fuel for that stretch never exist.                                        |
| Trip open, session not moved  | Position utilization says the worker was at Machine 2 while a trip accrues kilometres. Both reports are wrong and neither looks wrong. |
| Trip open, vehicle unassigned | Two drivers can take the same van. Discovered in the yard, not in the app.                                                             |

So `DrivingCommandService.beginDriving` does all of it inside `transactions.run`, and the domain
event is published **after** the commit — never inside it, since a listener must not be able to see
a state that may still roll back.

This is the one place a module's repository port reaches across a module boundary.
`DrivingRepository` is declared in `modules/shifts/src/domain/ports.ts` and implemented by
`PrismaDrivingRepository`, which touches driver, vehicle and trip tables. The alternative — calling
the drivers module's service from the shifts module — would mean two transactions and therefore the
table above. The port keeps the dependency pointing inward (shifts owns the interface; the adapter
is infrastructure) and the deviation is deliberate and confined to this one flow. See
[modular-architecture.md](./modular-architecture.md).

---

## 3. What makes a position a driving position

`Position.kind`, an enum with `STANDARD` and `DRIVING`. Not a name match, not a code convention,
not a flag on the site. A tenant that calls the position "Chauffeur", "Voznik" or "Курс" gets the
same behaviour, because the behaviour is attached to the column.

The API decides the route from `kind`; the client only renders what the server sent. The position
list returns the kind per position so the worker portal can show the "МПС" badge and know that
tapping it opens the vehicle picker rather than the confirmation — but the client's opinion about
which position is a driving one has no authority. `POST /worker/driving/begin` re-checks the
position, the eligibility and the driver profile server-side regardless of what the client believed.

---

## 4. Who may drive

`assertCanDrive` requires all three:

1. **A `Driver` profile linked to this worker** via `Driver.workerId`. There is deliberately no
   create-on-demand path. A driver record carries a licence number and an expiry; conjuring one
   because somebody tapped a position would put an unlicensed person behind a company vehicle with
   the system's blessing. A worker with no driver profile gets `driving.no_driver_profile`, and a
   fleet manager has to link them.
2. **Profile status `ACTIVE`.** A suspended driver is suspended.
3. **A licence that has not expired.** A hard stop (`driving.license_expired`), not a warning. An
   expired licence is something to fix before the vehicle moves, not a note in next month's report.

On top of that, the ordinary position-eligibility rules still apply — qualifications, capacity,
change mode, supervisor approval. The driving check is additional, never a replacement. A position
requiring supervisor approval cannot be entered through this flow at all; `beginDriving` refuses
`requiresApproval` rather than starting a trip that a supervisor might then decline.

---

## 5. The vehicle picker

`GET /worker/positions/:positionId/vehicles` returns only vehicles the worker may actually take:

- status `ACTIVE` — a vehicle in maintenance or out of service is not offered,
- unassigned, **or** already assigned to this driver,
- the driver's own vehicle sorted first, then by registration number.

Two properties matter here:

**Filtering happens on the server.** A vehicle the caller may not take is never in the response.
Filtering in the client would put the whole fleet on the wire and make the rule advisory.

**Eligibility is checked before the fleet is listed.** Otherwise this endpoint becomes a way to
enumerate an organization's vehicles by asking about a driving position the caller cannot occupy.

Putting the driver's own vehicle at the top is not decoration. On most mornings it is the one they
want, which turns the picker into a confirmation — one tap instead of a search through a list of
forty registrations at 05:30.

---

## 6. Assignment conflicts are refusals

`planAssignment` returns `REUSE` when the driver already holds this vehicle and `CREATE` otherwise.
Everything else throws:

| Situation                                       | Result                          |
| ----------------------------------------------- | ------------------------------- |
| Vehicle not `ACTIVE`                            | `driving.vehicle_not_available` |
| Vehicle held by another driver                  | `driving.vehicle_taken`         |
| This driver already holds a _different_ vehicle | `driving.already_holds_vehicle` |

None of these is resolved silently. Quietly reassigning a vehicle away from another driver, or
quietly dropping the one this driver already holds, is the kind of helpfulness that loses a van at
06:00 and costs someone an hour working out why. The refusal names the conflict; a person resolves
it.

### Automatic versus manual assignments

`VehicleAssignment.isAutomatic` distinguishes the two kinds:

- **`true`** — created by this handoff. Closed when the driver leaves the driving position or the
  shift ends.
- **`false`** — created by a fleet manager. A long-term assignment that survives the driver going
  home and coming back tomorrow.

`closeAutomaticAssignment` filters on `isAutomatic: true`, so ending a trip never undoes a fleet
manager's decision. Without the flag, one trip in someone else's van would silently dissolve a
standing assignment.

---

## 7. Session elevation

The worker keeps the session they logged in with. While the driving session is open, the server
writes `driverId` onto it and adds the driving permissions:

```
driver.portal.access
driver.trip.start
driver.trip.stop
driver.trip.history
driver.vehicle.view
```

Driving elevates the session; it does not hand the worker a control the product no longer has.
There is no `driver.trip.pause` in this list because there is no pause anywhere — see
[driver-fleet.md](driver-fleet.md) § 2.

Both are removed when the driving session closes.

Two alternatives were rejected:

- **Issue a second, `DRIVER` session.** One person would then have two live sessions and two places
  to revoke. A supervisor ending someone's access would have to get both, and would eventually get
  one.
- **Add a fourth actor type.** Every guard in the codebase would have to learn about it, to express
  something that is really just "this worker is currently driving".

Consequently the driver routes are gated on **driving context**, not actor type:
`requireDriverContext()` demands `driver.portal.access` **and** a resolved `actor.driverId`, and
accepts actor type `DRIVER` or `WORKER`. `setDrivingContext` only ever writes to a session whose
actor type is `WORKER`, so the elevation cannot be pointed at anything else.

The driver id is never read from the request. A worker who posts a `driverId`, sets a header, or
replays a captured request body still has no `actor.driverId` and is refused — see
`tests/integration/api-security.test.ts`.

This is an instance of the permission-snapshot decision in
[ADR-0005](./decisions/0005-session-permission-snapshot.md): permissions live on the session, which
buys a fast authorization check and owes an explicit revocation duty. Here that duty is discharged
by the same transaction that closes the driving session.

---

## 8. Leaving the driving position

`endDrivingForSession` runs inside the transaction of whatever is closing the position session — a
position change, or the end of the shift. It:

1. finds the trip linked to the session (`DriverTrip.positionSessionId`, unique),
2. checks it can be closed (`assertCanEndDriving`),
3. closes it, recomputing distance from the stored points and re-deriving gaps,
4. closes the assignment if this flow created it,
5. and the caller strips the driving permissions from the session.

**It is idempotent.** No trip, or a trip already `COMPLETED`/`CANCELLED`, returns `null` rather than
throwing, so a partially-applied handoff can always be finished rather than leaving a worker stuck
in a position they cannot leave.

**Distance is recomputed, never accumulated from the client.** `closeTrip` calls
`computeTrackDistance` over the stored points and `findTrackingGaps` for the silence, so the closing
figures come from the same code as every other report. A client-supplied total is not accepted
anywhere in this flow.

---

## 9. Recording with the screen off

The user requirement is that the app records the route "дори с изгасен дисплей на заключено
устройство" — even with the display off on a locked device.

**A web app cannot do this**, and the code does not pretend otherwise. This product is web-based
by decision, so the driver portal reads `detectCapabilities()` and states what will actually happen
on that device before the trip starts: recording needs the screen on, and a Screen Wake Lock keeps
it on. Installing the app to the home screen helps — Android is slower to shut it down — but it
grants no background-location permission. See
[tracking-client.md §1](./tracking-client.md#1-the-honest-answer-about-a-locked-screen).

Whichever the device is, silence is treated the same way: it becomes a tracking gap, reported
neutrally as "app no longer reporting". **A gap is never presented as the driver having
intentionally disabled tracking** — a tunnel, a flat battery and a force-quit are indistinguishable
from the server's side, and guessing between them would put an accusation in a record that feeds
someone's pay.

---

## 10. Schema

```prisma
enum PositionKind { STANDARD DRIVING }

model Position {
  kind PositionKind @default(STANDARD)
}

model VehicleAssignment {
  // True when the worker→driver handoff created it, and it should be released
  // when the driver leaves the driving position.
  isAutomatic Boolean @default(false)
}

model DriverTrip {
  // The session this trip belongs to. Unique: one trip per driving session,
  // which is what makes closing the session able to find and close the trip.
  positionSessionId String? @unique
  positionSession   PositionSession? @relation(...)
}
```

The migration `20260820094500_driving_positions` also relaxes the session check constraint so a
worker session may carry a `driverId`:

```sql
OR ("actorType" = 'WORKER' AND "workerId" IS NOT NULL AND "userId" IS NULL)
```

Migrations touching these tables must be hand-written. Prisma's `migrate diff` does not know about
the composite `(organizationId, id)` tenant keys or the `same_tenant` foreign keys and will propose
dropping them — see [database.md](./database.md).

---

## 11. Tests

Unit (`tests/unit/driving.test.ts`) — the rules in isolation: who may drive, what the picker
offers and in what order, every assignment conflict, permission elevation and its exact inverse.

Integration (`tests/integration/driving-handoff.test.ts`) — the transaction: that the handoff
either applies completely or not at all, that a worker ends up with exactly one open position
session, that the session gains and then loses driving access, and that a second driver cannot take
a vehicle already held.
