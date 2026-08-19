# Markets and pricing

AYtracker is global-ready from day one. Bulgaria is the first market, not a hardcoded assumption
— there is no `if (country === 'BG')` anywhere in the codebase, and adding a country is inserting
rows.

---

## 1. A market is not a country

A **market** is a commercial region. Several countries can share one, and one country can have
its own if it is priced separately.

| Market   | Countries              | Currency | Tax scheme                         |
| -------- | ---------------------- | -------- | ---------------------------------- |
| `BG`     | BG                     | EUR      | EU VAT                             |
| `DE`     | DE                     | EUR      | EU VAT                             |
| `EU`     | 25 remaining EU states | EUR      | EU VAT                             |
| `US`     | US                     | USD      | US sales tax (provider-calculated) |
| `GLOBAL` | — (fallback)           | EUR      | None                               |

`Market.priority` breaks ties: `DE` (priority 10) beats `EU` (priority 50) for Germany. A market
also carries its default locale, timezone, measurement system, and `blockedFeatures` for
regulatory carve-outs.

---

## 2. Market resolution

The signal chain, highest trust first:

```
1. Authenticated organization's billing country     ← server-held
2. Billing customer's country                       ← server-held
3. Explicit user-selected market                    ← client-influenced
4. Server-side IP geolocation                       ← client-influenced
5. Browser locale / timezone                        ← client-influenced
6. Global default
```

### The security property

**The two signals a customer can influence rank below the billing country the server holds.**

That single ordering is what makes "never allow a customer to manipulate a request to obtain
another country's cheaper price" true rather than intended. A visitor from Germany may click
"show Bulgarian prices" and see them; a _German organization_ is charged German prices no matter
what their browser, IP, or request body claims.

The mechanism is stronger than an ordering, though. For an authenticated organization the API
does not call `resolve()` at all — it calls a different method:

```ts
resolveForOrganization(billingCountry: CountryCode): ResolvedMarket
```

There is no parameter on that method through which a client-influenced signal could arrive. The
market comes from a database read of `billingCountry`. Even a bug in the priority ordering could
not open the hole, because the weak signals are never in scope.

### Tax authority

Every resolution carries `isTaxAuthoritative`:

```ts
TAX_AUTHORITATIVE_SOURCES = { ORGANIZATION_BILLING_COUNTRY, CUSTOMER_BILLING_COUNTRY };
```

An IP address is **not** proof of tax residency. A market resolved from one may set displayed
prices; it must never compute or charge VAT. The public pricing endpoint returns net prices with
`tax: { calculated: false, note: 'tax.calculated_at_checkout' }` for anonymous visitors, because
inventing a VAT figure from an IP address would be a number nobody can stand behind.

---

## 3. Pricing is data

Prices are **immutable, versioned rows**. Changing a price means inserting a new row and
retiring the old one.

```
Price
  id, planId, marketId, currency, interval,
  amount, status, effectiveFrom, effectiveTo,
  isPromotional, promotionCode, externalPriceId
```

`status`: `DRAFT` → `ACTIVE` → `GRANDFATHERED` → `RETIRED`.

### Why immutability matters

A `Subscription` stores `priceId` — the exact row it was sold at. It is never re-resolved from
the catalog. So:

- A customer sold at €39 keeps paying €39 when the list price moves to €49.
- Founding pricing survives a repricing without a special case.
- An invoice from 2026 can be reconstructed in 2029 by reading the row it referenced.

**Changing a price cannot silently change an existing customer's price**, because there is no
code path that looks a subscription's price up by market and plan.

### PricingCatalog

```ts
findSellable({ marketCode, planCode, interval, at })    // what a new customer is offered
findPromotional({ ..., promotionCode })                 // only when the code is presented
findById(priceId)                                       // what an existing subscription pays
listForMarket(marketCode)                               // the public pricing page
annualSavingPercent(marketCode, planCode)
```

Three invariants, each a test:

1. Selection is by `(market, plan, interval)` — never by anything the client sends beyond a plan
   code.
2. Only `ACTIVE` rows inside their effective window are sellable. `GRANDFATHERED` rows resolve by
   id but are never offered.
3. A promotional row is **never** returned by a plain lookup or listed publicly. It must be asked
   for by code.

Backed by a partial unique index so the data cannot contradict rule 1:

```sql
CREATE UNIQUE INDEX "prices_one_active_per_market_plan_interval"
  ON "prices" ("marketId", "planId", "interval")
  WHERE "status" = 'ACTIVE' AND "isPromotional" = false;
```

### Launch prices (illustrative, seeded)

| Market | Starter | Professional | Business |
| ------ | ------- | ------------ | -------- |
| BG     | €49     | €89          | €179     |
| DE     | €69     | €129         | €249     |
| EU     | €59     | €109         | €219     |
| US     | $99     | $199         | $399     |
| GLOBAL | €69     | €129         | €259     |

Annual is 10× monthly — roughly a 17 % saving, computed by `annualSavingPercent` rather than
stated twice.

---

## 4. Currency

`CurrencyService` formats and validates. It deliberately does **no FX conversion**.

Prices are authored per market in the currency that market is billed in. Converting at display
time would show a number the customer is not actually charged. If cross-currency reporting is
ever needed it gets its own service with an explicit rate source and rate date — that is a
feature with a paper trail, not a default that quietly guesses.

Money is integer minor units throughout (`packages/domain/src/money.ts`), with per-currency
exponents so JPY (0 decimals) and KWD (3) work without special-casing at the call site.

---

## 5. Tax

`TaxService` computes EU VAT for a SaaS subscription sold by an EU seller.

| Situation                                     | Treatment              | Charged           |
| --------------------------------------------- | ---------------------- | ----------------- |
| Domestic (seller country = customer country)  | `STANDARD_RATE`        | Seller's rate     |
| Cross-border EU B2B, **validated** VAT number | `REVERSE_CHARGE`       | 0 %               |
| Cross-border EU, no validated VAT number      | `STANDARD_RATE`        | Destination rate  |
| Customer outside the EU                       | `OUT_OF_SCOPE`         | 0 %               |
| US customer                                   | `DEFERRED_TO_PROVIDER` | Provider computes |

Two decisions worth naming:

**A claimed VAT number is not a validated one.** Without `vatValidatedAt` set from a VIES check,
the destination rate applies. Saying "I am a business" is not the same as being one.

**US sales tax is not computed here.** Nexus determination and rate sourcing are a provider
problem (Stripe Tax, Avalara). `TaxService` returns a deferral marker rather than a number,
because returning a wrong US number would be worse than returning none. The billing service
routes those to the provider.

Rates live in a data table (`EU_VAT_RATES`), updated by migration when a member state changes
one. Tax logic never runs in React.

---

## 6. Adding a market

1. Insert a `Market` row: code, countries, currency, locale, timezone, measurement system, tax
   scheme, priority.
2. Insert `Price` rows for each plan and interval.
3. If the market blocks a feature for regulatory reasons, list it in `blockedFeatures`.
4. If it uses a new language, add the locale ([localization.md](localization.md)).
5. Add a resolution test asserting the country maps to the market.

No code changes. `MarketService` caches both tables for five minutes and `invalidate()` clears it
after an edit.

---

## 7. Tests

`tests/unit/market-pricing.test.ts` (25 tests):

```
Organization billing country beats a US IP and a US market selection
An IP-derived market is marked non-authoritative for tax
A visitor-selected market is marked non-authoritative for tax
resolveForOrganization considers exactly one signal
The more specific market wins when two claim a country
Promotional prices never appear in a plain lookup or the public list
A grandfathered price still resolves by id, and is never sold to a new customer
Domestic VAT, reverse charge, destination rate, out of scope, US deferral
Tax rounds to the currency's minor unit
```
