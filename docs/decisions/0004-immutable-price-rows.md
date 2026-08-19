# 4. Immutable, versioned price rows

**Status:** Accepted

## Context

"Changing a price must not silently change an existing customer's price." The obvious model —
one price row per (plan, market, interval), updated in place — violates this the moment anyone
edits it.

## Decision

Prices are immutable rows with `status`, `effectiveFrom` and `effectiveTo`. A change inserts a new
row and retires the old one. `Subscription.priceId` points at the exact row sold.

## Consequences

- Grandfathering, founding pricing and promotions all work without special cases — they are
  states of a row, not features bolted on.
- An invoice from 2026 can be reconstructed in 2029 by reading the row it referenced.
- The prices table grows. Trivially: a handful of rows per market per plan per year.
- A subscription's price is resolved by id, never re-derived. `findById` returns retired rows
  precisely so this works.
- A partial unique index enforces one active non-promotional price per slot, so the data cannot
  contradict the model.
