# 3. RLS as defense in depth, not the primary control

**Status:** Accepted

## Context

The brief asked for PostgreSQL RLS "as defense in depth where practical". Making it the _primary_
control means `FORCE ROW LEVEL SECURITY` plus a tenant GUC on every connection.

## Decision

Enable RLS with policies on 35 tenant tables. Do **not** set `FORCE`. Application connects as a
non-owner role in production; migrations connect as the owner.

## Rationale

With `FORCE`, any code path that forgets to set the GUC returns zero rows — including migrations,
maintenance scripts and jobs. The failure mode is an outage, and it arrives at the worst moment.

Without `FORCE`, the policies apply to the application role (which is what faces the internet) and
not to the owner (which runs supervised, reviewed operations). The application-layer tenant filter
and the composite foreign keys are already two independent controls; RLS is the third.

## Consequences

- RLS is **inert against the owner**, including in local development. Stated plainly in
  `multi-tenancy.md` rather than left as a comfortable assumption.
- Production needs a non-owner role and two database URLs.
- `withTenant` costs one extra statement per transaction to set the GUC. Accepted — `SET LOCAL`
  scoping is what stops one request's tenant leaking into the next on a pooled connection.
- If a future audit requires RLS as the primary control, `FORCE` plus a connection-level GUC is
  the path, and every job needs auditing first.
