# 2. Composite tenant foreign keys

**Status:** Accepted

## Context

Every tenant-owned row carries `organizationId`. The application always filters by it. But a
child row also holds foreign keys — a shift references a site — and a plain
`FOREIGN KEY (siteId) REFERENCES sites(id)` permits a shift in organization A to reference a site
in organization B.

Nothing in the application would normally do that. But "normally" is doing a lot of work in that
sentence: an import, a backfill, a future integration adapter, or a bug in a new module could.

## Decision

Every parent gets `UNIQUE (organizationId, id)`. Every child references the **pair**:

```sql
FOREIGN KEY ("organizationId", "siteId") REFERENCES "sites" ("organizationId", "id")
```

36 such constraints across the schema.

## Consequences

- A cross-tenant reference is **impossible**, not merely unlikely. The insert fails.
- One extra unique index per parent table. Negligible.
- Adding a table with foreign keys means adding these constraints — documented in
  `multi-tenancy.md` § 6 and covered by the isolation test.
- `MATCH SIMPLE` means a NULL in any FK column skips the check, which is what optional relations
  need. Worth knowing before assuming a nullable FK is covered.
