# 7. Ship partial locale catalogs with per-key fallback

**Status:** Accepted

## Context

The brief lists six initial languages: bg, en, de, ro, pl, cs. Translations for ro, pl and cs
could be machine-generated, but a mistranslated "End shift" button is an operational problem, not
a cosmetic one — and nobody on this build can verify Romanian, Polish or Czech phrasing.

## Decision

Ship `en`, `bg` and `de` complete and typed as full catalogs. Declare `ro`, `pl` and `cs` as
partial catalogs that fall back to English **per key**. Expose `catalogCoverage()` and assert the
split in a test.

## Rationale

The three options were: omit them (breaks the architectural claim that adding a language is
easy), machine-translate and call them done (ships unverified strings into a factory), or ship
them partial and say so.

The third is the only one that is honest. The fallback machinery is the part that matters
architecturally, and it is fully built and tested. What is missing is translation work, which is
a task with a name rather than a hidden defect.

## Consequences

- A Polish user sees a mix of Polish and English until the catalog is completed.
- `COMPLETE_LOCALES` drives what a language picker should offer.
- A test asserts complete locales are at 100 % and partial ones are not, so the gap cannot quietly
  become an assumption.
- Completing a catalog is: translate, retype as `MessageCatalog`, add to `COMPLETE_LOCALES`.
