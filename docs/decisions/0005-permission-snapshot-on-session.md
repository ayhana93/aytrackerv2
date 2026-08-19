# 5. Permission snapshot on the session

**Status:** Accepted

## Context

Authorization runs on every request. Resolving it live means joining
session → member → role → permissions each time.

## Decision

Copy the permission array onto the session row at issue time. Authorization becomes one indexed
read.

## Consequences

**The cost is invalidation, and it is real.** A permission change must revoke the affected
sessions or a user keeps stale permissions until theirs expires — up to 16 hours for a worker.

`SessionService.revokeForActor` handles it, and must be called on: role change, role permission
change, worker/driver deactivation, membership removal. This is the sharp edge of the tradeoff
and is reviewed on every change to roles or membership.

A password change is handled differently and better: `users.credentialsChangedAt` is compared
against `sessions.createdAt` on every lookup, so older sessions are simply not returned. No sweep
needed.

**Alternative considered:** a short-TTL permission cache keyed by member. It removes the
invalidation duty but adds a cache to reason about and still has a staleness window. The explicit
revocation path is more honest about when permissions actually change.
