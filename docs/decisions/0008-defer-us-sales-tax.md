# 8. Defer US sales tax to the payment provider

**Status:** Accepted

## Context

The brief asks for a US sales tax architecture. US sales tax depends on economic nexus per state,
thousands of jurisdictions, product taxability rules that differ for SaaS, and rates that change
without much notice.

## Decision

`TaxService` returns `DEFERRED_TO_PROVIDER` with a zero amount for `US_SALES_TAX`. The billing
service routes those to the provider (Stripe Tax or equivalent). EU VAT **is** computed here.

## Rationale

Returning a wrong US tax number would be worse than returning none: it would appear on an invoice
and be relied upon. A deferral marker is unambiguous — the code says "someone else computes this",
and the type system carries it.

EU VAT is different: the rules are tractable (destination principle, reverse charge with a
validated VAT number), the rate table is small and stable, and getting them right is a genuine
differentiator for an EU-first product.

## Consequences

- US launch depends on a tax provider being configured. Named as a dependency rather than
  discovered later.
- `TaxResult.treatment` carries the deferral explicitly, so no caller can mistake a zero for
  "no tax due".
- The same seam handles future schemes (UK VAT, Canadian GST/HST) by adding a treatment.
