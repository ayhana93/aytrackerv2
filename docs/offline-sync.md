# Offline sync

A factory floor has dead spots. A driver on a mountain road has none of it. Both must be able to
keep working, and neither may end up with duplicated records when the connection returns.

---

## 1. The contract

```
Worker / Driver UI
      ↓
  Local state          instant interaction, never blocked on the network
      ↓
  IndexedDB            queued actions survive a reload or a crash
      ↓
  Sync queue           replays in order on reconnect
      ↓
  API                  idempotency ledger
      ↓
  PostgreSQL
```

**Every mutation carries a client-generated `clientActionId` (UUID v4).** That is the entire basis
of safe replay.

---

## 2. Idempotency

`IdempotencyKey` is scoped by `(organizationId, actorType, actorId, clientActionId)` — unique, so
one actor's key cannot collide with another's.

```
claim(clientActionId, endpoint, requestHash)
   ├─ no row        → INSERT PENDING, caller owns execution
   ├─ COMPLETED     → return the stored response verbatim
   ├─ PENDING       → 409 idempotency.in_progress
   └─ different hash→ 409 idempotency.key_reused
```

Four behaviours worth stating:

**A replay returns the stored response, not a fresh one.** The client sees exactly what it would
have seen the first time — including the ids it needs to reconcile local state.

**A reused key with a different body is a conflict, not a replay.** `requestHash` catches a client
bug that would otherwise silently return the wrong answer.

**A failed command releases its claim.** A genuine retry can proceed. Without this a transient
failure would wedge that action forever. Tested: an ineligible position change fails, then the
same key succeeds against an eligible one.

**The unique index makes the claim atomic.** Two concurrent replays both try to insert; one gets
the unique violation and is told the action is in flight.

Keys expire after 48 hours — long enough for a weekend of queued actions.

### Where it is not applied

Location batches are **not** wrapped. A batch is a set of points; appending the same point twice
is prevented by the accepted-timestamp cursor, and writing an idempotency row per batch would
double the write volume of the busiest endpoint in the system.

---

## 3. Timestamps

An action queued at 09:14 and synced at 11:02 should be recorded at 09:14. But the device clock is
not trusted.

```ts
reconcileClientTimestamp({
  clientTimestamp,
  serverNow,
  maxBacklogSeconds: 16 * 3600, // one long shift
  maxSkewAheadSeconds: 120, // tolerance for a fast clock
});
```

| Case                   | Result                                                                   |
| ---------------------- | ------------------------------------------------------------------------ |
| Inside the window      | Accepted as sent                                                         |
| Older than the backlog | Clamped to the window start                                              |
| In the future          | Replaced with server time — an action has happened by the time we see it |

Every clamp is logged at `warn` with the claimed and used values. A device a day out cannot
backdate a shift.

---

## 4. Which actions are offline-capable

| Action                            | Offline | Note                                  |
| --------------------------------- | ------- | ------------------------------------- |
| Start / end shift                 | ✅      |                                       |
| Start / end break                 | ✅      |                                       |
| Change position                   | ✅      | Eligibility is cached with the picker |
| Record production                 | ✅      |                                       |
| Start / pause / resume / end trip | ✅      |                                       |
| Submit locations                  | ✅      | Queued and backfilled                 |
| Read own history                  | Cached  | Read-only                             |
| Any admin action                  | ❌      | Requires connectivity                 |

Position eligibility is cached with the position list. A worker offline for hours could
theoretically act on stale eligibility — the server re-checks on replay and rejects the action,
which is the correct outcome even though the worker learns about it late.

---

## 5. Sync protocol

```http
POST /api/v1/sync/batch
{
  "actions": [
    { "clientActionId": "…", "endpoint": "worker.shift.start",
      "occurredAt": "2026-03-10T09:14:00Z", "payload": { … } },
    …
  ]
}
```

Up to 100 actions, applied **in order**. Each carries its own key, so a partially applied batch
can be retried whole without duplicating what already landed.

Per-action outcomes come back so the client can prune its queue:

```json
{ "results": [ { "clientActionId": "…", "status": "APPLIED" | "REPLAYED" | "REJECTED",
                 "error": { "code": "…" } } ] }
```

`GET /api/v1/worker/sync/state` returns the server's view — recently applied action ids and the
server time — so a client that lost its local record can reconcile rather than re-send.

---

## 6. Conflict handling

Server state wins. There is no merge.

| Conflict                               | Outcome                                                |
| -------------------------------------- | ------------------------------------------------------ |
| Shift already started (another device) | `409 shift.already_active`; client adopts server state |
| Position session already closed        | `409 position.session_already_closed`; refresh         |
| Trip already ended                     | `409 trip.already_ended`; refresh                      |
| Worker deactivated while offline       | Actions rejected; session revoked                      |
| Qualification revoked while offline    | Position change rejected on replay                     |

A rejected action is surfaced to the user with its reason rather than dropped silently — a worker
whose position change did not take needs to know before the shift ends.

---

## 7. Client requirements

Server-side is complete; the client is Phase 8 and blocked on the design phase for its UI. The
contract it must satisfy:

**Service worker** — app shell cached; API responses **not** cached beyond the current session's
read models.

**IndexedDB** stores: the action queue, the current shift/trip state, the cached position list,
and pending location points. Nothing else.

**Do not store more sensitive data than necessary.** No worker roster, no other drivers' data, no
historical location beyond the active trip. A lost phone should not be a data breach.

**Queue durability** — actions survive reload and crash; the queue drains in order on reconnect
with exponential backoff.

**Visible state** — `offline` / `syncing` / `synced` must be visible, not inferred. A worker
should never wonder whether their shift was recorded.

---

## 8. Tests

`tests/unit/shift-duration.test.ts` — timestamp reconciliation: accepted, clamped backwards,
never accepted from the future, small skew tolerated.

`tests/integration/api-security.test.ts`:

```
A replay returns the stored response and starts exactly one shift
A reused key with a different body → 409 idempotency.key_reused
A failed command releases its claim, so a retry succeeds
```
