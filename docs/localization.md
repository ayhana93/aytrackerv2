# Localization

Adding a language must not require rewriting components. Adding a country must not require
rewriting formatting.

---

## 1. Supported locales

| Code | Language  | Status                               |
| ---- | --------- | ------------------------------------ |
| `en` | English   | **Complete** — the reference catalog |
| `bg` | Български | **Complete**                         |
| `de` | Deutsch   | **Complete**                         |
| `ro` | Română    | Partial — awaiting native review     |
| `pl` | Polski    | Partial — awaiting native review     |
| `cs` | Čeština   | Partial — awaiting native review     |

### Why three are partial, stated rather than hidden

`ro`, `pl` and `cs` are declared, wired end to end, and fall back to English **per key**. They are
usable, not broken.

Shipping a half-guessed Polish interface as if it were finished would be worse than an English
fallback a customer can read — a mistranslated "End shift" button is an operational problem, not a
cosmetic one. `catalogCoverage(locale)` reports exactly how complete each is, and a test asserts
that the complete locales are at 100 % and the partial ones are not, so the gap stays visible
instead of drifting into an assumption.

They need native review before those markets launch.

---

## 2. Type-safe catalogs

English is the reference. Every complete catalog is typed against it:

```ts
export const bg: MessageCatalog = { … };   // a missing key is a compile error
```

Partial catalogs are `Partial<MessageCatalog>` and resolve missing keys at lookup time. So a
misspelled key never reaches a customer as `[object Object]`, and an incomplete translation never
reaches them as a blank.

---

## 3. Resolution

```
1. User preference          users.preferredLocale
2. Organization default     organizations.defaultLocale
3. Browser                  Accept-Language, highest supported q-value
4. Market default           markets.defaultLocale
5. Global default           en
```

Regional tags map to their base language: `de-AT` → `de`. `parseAcceptLanguage` walks the header
by weight and picks the first supported language rather than taking the first entry.

---

## 4. No user-facing strings in business logic

This is the rule the architecture is built around.

Services raise machine-readable error codes:

```ts
throw new ConflictError('shift.already_active', 'Worker already has a shift in progress.');
```

- `code` is stable and machine-readable. Clients branch on it.
- `message` is developer-facing English. It appears in logs, never in a customer's interface.

The presentation layer turns the code into a sentence:

```ts
messageKeyForErrorCode('shift.already_active') → 'shift.already_active'
translator.t('shift.already_active')           → "Вече имате започната смяна."
```

Unmapped codes degrade to `error.generic` rather than leaking English internals.

The same applies to tracking events: `TRACKING_EVENT_MESSAGE_KEYS` maps each event type to a key,
so the neutral wording ([tracking.md](tracking.md) § 4) is translated rather than hardcoded.

---

## 5. Interpolation and plurals

```ts
t('auth.account_locked', { seconds: 60 }); // "Try again in 60 seconds."
```

An unknown placeholder is left intact (`{seconds}`) rather than rendered as `undefined` — a
visible bug beats a silent one.

Deliberately **not** a full ICU MessageFormat implementation. Plurals select a different key via
`Intl.PluralRules`:

```ts
translator.plural('shift.hours', 3); // → shift.hours.other in en, shift.hours.few in cs
```

Catalogs stay readable for non-technical translators, and the worker portal does not ship a
formatting engine.

---

## 6. Formatting

All `Intl`-based, so date, number and unit formats follow the locale without a per-country lookup
table anywhere in the codebase.

```ts
formatDate / formatTime / formatDateTime; // with an explicit IANA timezone
formatNumber / formatPercent;
formatDuration; // "7 hr 32 min" in the locale's own words
formatDistance; // km or miles, from the organization's measurement system
formatConsumption; // L/100 km or mpg
```

Distance and consumption take the measurement system from the organization (which inherits it
from its market). The **stored** value is always metric — metres and litres per 100 km. Only the
presentation changes.

Currency formatting lives in `CurrencyService` because it needs the per-currency minor-unit
exponent ([market-pricing.md](market-pricing.md) § 4).

---

## 7. Timezones

Separate from language. A German-speaking manager can supervise a Bulgarian site: the interface
is German, the shift times are `Europe/Sofia`.

Resolution: site timezone → organization timezone → market default → UTC.

Storage is always UTC ([architecture.md](architecture.md) § 7).

---

## 8. Adding a language

1. Add the code to `SUPPORTED_LOCALES` and `LOCALE_META` (native name, default currency, default
   timezone, direction).
2. Create `messages/<code>.ts`, typed as `MessageCatalog` once complete.
3. Register it in `CATALOGS`.
4. Add it to `COMPLETE_LOCALES` when a native speaker has reviewed it.
5. Run the coverage test.

No component changes. No business-logic changes.

RTL is accommodated in the model (`LocaleMeta.direction`) but untested — the first RTL language
needs a layout pass before it can be called complete.

---

## 9. Tests

`tests/unit/time-and-money.test.ts` (localization section):

```
User preference beats organization, browser and market
The full fallback chain, including an unsupported language falling through
Accept-Language weighting; a regional tag mapping to its base language
An untranslated key falls back to English, and `has()` reports it as untranslated
Placeholders interpolate; an unknown one is left intact
Complete locales are at 100 % coverage; partial ones are not
Duration and distance formatting, metric and imperial
```
