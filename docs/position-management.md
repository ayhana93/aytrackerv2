# Position management

The critical workflow. A worker must be able to change position in two to three seconds, and it
must be impossible to abuse. Those two goals pull in opposite directions, and this document is
how they are reconciled.

---

## 1. PositionSession is the source of truth

Never a mutable JSON summary. Time at a position is derived by summing closed sessions.

```
PositionSession
  id, organizationId, shiftId, workerId, positionId,
  startedAt, endedAt, durationSeconds, source, correctedAt
```

Why this matters: with a summary blob, a correction is an invisible recomputation and history is
unreconstructable. With rows, a correction is a visible, audited edit to one row and the history
is the rows themselves.

```
10:00  Machine 1
10:32  Machine 1 → Machine 2
13:14  Machine 2 → Packaging
```

Those are three rows, two of them closed, one open.

---

## 2. The position change

### The two-second requirement

All the expensive work happens **before** the transaction opens:

```
1. Eligibility check      (outside the transaction — a refusal holds no locks)
2. BEGIN
3.   load open session    (indexed: organizationId, shiftId, endedAt IS NULL)
4.   close it             (compare-and-set on endedAt IS NULL)
5.   open the new one
6. COMMIT
7. publish position.changed
```

The transaction is two writes against indexed rows. The worker sees one confirm.

### The invariant

**A worker must never have two active position sessions for one shift.**

Three independent mechanisms:

1. **Application** — `planPositionChange` refuses to plan a change from an already-closed
   session, or to a position the worker is already on (which would create a zero-length row).
2. **Compare-and-set** — the close is `UPDATE … WHERE id = ? AND endedAt IS NULL`. A concurrent
   close writes zero rows and raises `position.session_already_closed` rather than silently
   overwriting the first one's end time.
3. **Database** —

```sql
CREATE UNIQUE INDEX "position_sessions_one_open_per_shift"
  ON "position_sessions" ("shiftId") WHERE "endedAt" IS NULL;

CREATE UNIQUE INDEX "position_sessions_one_open_per_worker"
  ON "position_sessions" ("workerId") WHERE "endedAt" IS NULL;
```

The second covers the case the first misses: a worker somehow open on two different shifts.

`tests/integration/position-change.test.ts` runs six changes in sequence and two concurrently,
asserting one open session and no overlapping rows in both cases.

---

## 3. Eligibility

`resolveEligibility` is a pure function. It reads no clock and no database — the caller passes
`now` and the loaded inputs. There is no argument through which a caller could supply a "yes".

### Resolution order

```
1. An in-force explicit DENY          → refused, always
2. Position inactive / at capacity    → refused
3. An in-force explicit ALLOW         → granted, without a qualification
4. The position's change mode
```

**Why DENY outranks everything:** it is how a supervisor removes someone from a machine after an
incident. Nothing may override it — not a qualification, not an ALLOW, not an admin's plan.

**Why ALLOW can skip a qualification:** it is the documented escape hatch for a trainee working
under supervision. It is explicit, attributable (`grantedByUserId`), and time-boundable
(`validFrom` / `validTo`).

**Why an inactive position still refuses an ALLOW:** a machine that is out of service is out of
service for everyone.

### Change modes

| Mode                     | Behaviour                                     | For                                          |
| ------------------------ | --------------------------------------------- | -------------------------------------------- |
| `INSTANT`                | No qualification check                        | Packaging, general positions — the fast path |
| `QUALIFICATION_REQUIRED` | Worker must hold every required qualification | Machines                                     |
| `SUPERVISOR_APPROVAL`    | Qualification **and** approval                | Paint booth, critical stations               |

An `INSTANT` position stays instant even when the organization defaults to
`requireQualificationByDefault`. The default only tightens positions that have not decided —
otherwise the two-second path would disappear the moment an admin ticked a box.

### Qualifications

```
Worker ──< WorkerQualification >── Qualification ──< PositionQualification >── Position
```

A position may require several; the worker must hold **all** of them. An expired holding is not a
holding — `QUALIFICATION_EXPIRED` is a distinct reason from `QUALIFICATION_MISSING` so the message
can be useful ("your paint booth certification expired on…").

---

## 4. The picker

```
GET /api/v1/worker/state → { availablePositions: [...] }
```

Filtering happens on the **server**. A position the worker may not occupy is never sent, so the
picker cannot be tampered with to reveal or select one.

And filtering is not the security boundary — the change endpoint runs the identical eligibility
check. `api-security.test.ts` asserts both: the restricted position is absent from the picker,
_and_ requesting it directly returns `403 position.qualification_required`.

---

## 5. QR codes

```
CHANGE POSITION → SCAN QR → server resolves → same eligibility check → CONFIRM
```

**A QR code is an optimization, not the security mechanism.** The token is an addressing
convenience; the server still validates the authenticated worker, the active shift, eligibility,
qualification and position status. Scanning a code the worker may not use fails exactly as
tapping it would.

Tokens are rotatable (`Position.qrToken`) and tenant-scoped on lookup: scanning another company's
physical machine code reads as "not recognized", never as a position
([multi-tenancy.md](multi-tenancy.md) § 4).

---

## 6. History and corrections

**Workers cannot edit historical sessions.** There is no worker route that writes to a closed
session — `worker.*` permissions contain nothing that would allow it.

Corrections require `shifts.correct` (supervisor and above) and are validated:

| Check                     | Refusal                         |
| ------------------------- | ------------------------------- |
| Reason under 3 characters | `correction.reason_required`    |
| End before start          | `correction.end_before_start`   |
| Starts before its shift   | `correction.before_shift_start` |
| Ends after its shift      | `correction.after_shift_end`    |
| Overlaps another session  | `correction.overlaps_session`   |

Every correction writes a `Correction` row — original values, new values, `changedByUserId`,
reason, timestamp — **in the same transaction as the edit**. A correction cannot exist without its
audit record.

### A known limitation, stated plainly

A supervisor can _shrink_ a session but cannot _extend_ it into its neighbour: the overlap guard
refuses. Adjusting the boundary between two adjacent sessions needs both rows moved together, and
that is a separate command that does not exist yet.

The refusal is correct — silently creating overlapping history would be worse. The missing command
is tracked work, and there is a test asserting the current behaviour so it does not regress
unnoticed.

---

## 7. Anti-abuse

| Attack                   | Defence                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| Arbitrary assignment     | Server-side eligibility on every change                            |
| Duplicate sessions       | Partial unique indexes + compare-and-set                           |
| Impossible timestamps    | `reconcileClientTimestamp` clamps into a plausible window          |
| Changes after shift end  | The command requires an open shift                                 |
| Editing another worker   | Worker identity comes from the session; no route takes a worker id |
| Bypassing qualifications | The check is server-side; the picker is a convenience              |
| Duplicate requests       | Idempotency ledger keyed on `clientActionId`                       |
| Client manipulation      | No client value reaches the decision                               |

### Offline timestamps

A device queues an action at 09:14 and syncs at 11:02. The recorded time should be 09:14 — but the
device clock is not trusted. The compromise: accept it inside a bounded window (16 h back, 2 min
forward) and clamp anything outside. A device a day out cannot backdate a shift. Every clamp is
logged at `warn`.

---

## 8. Analytics without accusation

`analyzeSwitching` returns descriptive statistics:

```ts
{
  (changeCount, averageSecondsPerPosition, shortestStaySeconds, briefStayCount);
}
```

There is deliberately no `isSuspicious` field, and a test asserts the shape so one does not
appear. A high switch count can mean a worker is gaming a metric — or that a line is
short-staffed and someone is covering three machines. The system reports the number; a human
decides what it means.

---

## 9. Tests

`tests/unit/eligibility.test.ts` (19) — the full precedence ladder, expiry, capacity, overrides.
`tests/unit/position-session.test.ts` (18) — change planning, summaries, switching stats, corrections.
`tests/integration/position-change.test.ts` (17) — atomicity, concurrency, breaks, corrections.
`tests/integration/api-security.test.ts` — picker filtering and direct-request refusal.
