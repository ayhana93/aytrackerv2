# Billing

```
Application  →  BillingService  →  BillingProvider  →  Stripe
```

The application never imports Stripe. Swapping providers means writing one adapter — nothing
above the seam changes.

---

## 1. The provider seam

`BillingProvider` (`packages/billing/src/billing-provider.ts`) is deliberately small and free of
Stripe-shaped concepts:

```ts
createCustomer / updateCustomer;
createSubscription / changeSubscription / cancelSubscription;
listInvoices / createBillingPortalSession;
parseWebhook; // verifies the signature and normalizes the payload
```

Webhooks arrive as a normalized union — `SUBSCRIPTION_UPDATED`, `PAYMENT_FAILED`,
`TRIAL_ENDING`, … — so the application handles _events_, not Stripe objects.
`parseWebhook` throws if the signature does not verify: an unverified webhook is not an event.

Until Stripe is wired up (Phase 18), `UnconfiguredBillingProvider` is installed. It **throws** on
every call rather than silently succeeding — a no-op billing provider in production would mean
customers using the product with no subscription ever created.

---

## 2. Data model

```
Organization ─┬─ BillingCustomer   (1:1)  legal name, address, VAT, provider id
              └─< Subscription ── Plan
                       └───────── Price      ← the exact row sold, never re-resolved
```

`Plan` → `PlanFeature` → `Feature` defines what a plan unlocks.
`OrganizationEntitlement` is the resolved, queryable answer for one organization.

### Entitlements are derived, not asked for

```
active Subscription → Plan → PlanFeature → OrganizationEntitlement rows
                                              ↑
                                    manual grants override
```

The entitlement service is the only writer. Every plan check in the codebase goes through
`entitlements.can(...)` — there is no plan-tier comparison anywhere, which is what makes a new
plan a database row rather than a code change.

Resolution order: market block > entitlement row > expiry > metered limit. See
[authorization.md](authorization.md) § 6.

---

## 3. Plans

| Plan         | Adds                                              | Limits (workers / sites / vehicles / drivers) |
| ------------ | ------------------------------------------------- | --------------------------------------------- |
| Starter      | Workforce, shifts, production                     | 25 / 1 / 0 / 0                                |
| Professional | + analytics, offline, driver portal, white-label  | 100 / 3 / 0 / 15                              |
| Business     | + fleet, GPS, advanced reports, API, integrations | 500 / 10 / 50 / 50                            |
| Enterprise   | + AI assistant, custom work                       | unlimited                                     |

Seeded from `PLAN_DEFINITIONS`. These are the _initial rows_, not a hardcoded ruleset — the
application reads plans from the database at runtime, and changing one in production is a
migration or an admin action, not an edit plus a deploy.

---

## 4. Subscription lifecycle

```
TRIALING ──► ACTIVE ──► PAST_DUE ──► CANCELLED
                │           │
                └──► PAUSED ┘
                            └──► EXPIRED
```

| Event                        | Effect                                                     |
| ---------------------------- | ---------------------------------------------------------- |
| Trial ends, payment succeeds | `ACTIVE`                                                   |
| Payment fails                | `PAST_DUE`; entitlements stay live during the retry window |
| Retries exhausted            | `SUSPENDED` organization; portal read-only                 |
| Upgrade                      | Immediate, prorated; entitlements invalidated at once      |
| Downgrade                    | At period end, so the customer keeps what they paid for    |
| Cancellation                 | `cancelAt` set; access until the period ends               |

A **downgrade below current usage** (200 workers on a plan capped at 100) does not delete data.
The organization goes read-only for the affected module until usage is under the cap or the plan
is restored. Deleting a customer's data because their card expired is not an acceptable
behaviour for a system people run a factory on.

`subscriptions_one_live_per_org` (partial unique index) prevents a double subscription from a
retried checkout.

---

## 5. VAT and invoicing

`BillingCustomer` holds what an EU invoice legally requires: legal name, address, country, VAT
number, and `vatValidatedAt`.

- **VAT validation** is against VIES, stored with its timestamp and reference. A number that has
  not been validated does not trigger the reverse charge — see
  [market-pricing.md](market-pricing.md) § 5.
- **Billing country** is the authoritative tax signal. Changing it is a server-side, audited
  operation, never a field a request can flip to reach a cheaper market.
- **Invoices** are produced by the provider; AYtracker stores identifiers and links, not
  documents.

---

## 6. Quote flow

```
GET /api/v1/market/quote?plan=professional&interval=MONTHLY
  → resolveForOrganization(organizationId)        market from billing country
  → catalog.requireSellable(market, plan, ...)    net price
  → billingCustomer(organizationId)               country, business status, VAT validation
  → taxService.calculate(net, context)            tax treatment and amount
  → { net, tax, total, taxTreatment, taxRatePercent, reasonCode }
```

Requires a session: tax needs an authoritative billing country, which only an authenticated
organization has.

---

## 7. Not yet implemented

| Item                | Status                                          |
| ------------------- | ----------------------------------------------- |
| Stripe adapter      | Seam done; adapter is Phase 18                  |
| Webhook endpoint    | Normalized event types defined; handler pending |
| VIES validation     | Field and flow defined; client pending          |
| Dunning emails      | Depends on the notifications module             |
| Usage-based billing | Not planned; entitlement limits are hard caps   |

The seam is what matters now: everything above it is written against `BillingProvider`, so the
adapter is additive work rather than a refactor.
