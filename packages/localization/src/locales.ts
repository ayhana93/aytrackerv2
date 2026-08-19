import type { CurrencyCode, LocaleCode, TimezoneId } from '@aytracker/types';

/**
 * Supported languages.
 *
 * Adding one means: add the code here, add a message catalog, run the completeness test.
 * No component changes, no business-logic changes.
 */
export const SUPPORTED_LOCALES = ['bg', 'en', 'de', 'ro', 'pl', 'cs'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'en';

export function isSupportedLocale(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export interface LocaleMeta {
  readonly code: SupportedLocale;
  /** Name in the language itself — that is how a language picker should read. */
  readonly nativeName: string;
  readonly englishName: string;
  readonly defaultCurrency: CurrencyCode;
  readonly defaultTimezone: TimezoneId;
  readonly direction: 'ltr' | 'rtl';
}

export const LOCALE_META: Readonly<Record<SupportedLocale, LocaleMeta>> = {
  bg: {
    code: 'bg',
    nativeName: 'Български',
    englishName: 'Bulgarian',
    defaultCurrency: 'BGN',
    defaultTimezone: 'Europe/Sofia',
    direction: 'ltr',
  },
  en: {
    code: 'en',
    nativeName: 'English',
    englishName: 'English',
    defaultCurrency: 'EUR',
    defaultTimezone: 'UTC',
    direction: 'ltr',
  },
  de: {
    code: 'de',
    nativeName: 'Deutsch',
    englishName: 'German',
    defaultCurrency: 'EUR',
    defaultTimezone: 'Europe/Berlin',
    direction: 'ltr',
  },
  ro: {
    code: 'ro',
    nativeName: 'Română',
    englishName: 'Romanian',
    defaultCurrency: 'RON',
    defaultTimezone: 'Europe/Bucharest',
    direction: 'ltr',
  },
  pl: {
    code: 'pl',
    nativeName: 'Polski',
    englishName: 'Polish',
    defaultCurrency: 'PLN',
    defaultTimezone: 'Europe/Warsaw',
    direction: 'ltr',
  },
  cs: {
    code: 'cs',
    nativeName: 'Čeština',
    englishName: 'Czech',
    defaultCurrency: 'CZK',
    defaultTimezone: 'Europe/Prague',
    direction: 'ltr',
  },
};

export interface LocaleSignals {
  /** Explicit user preference. Highest priority. */
  readonly userPreference?: string | undefined;
  readonly organizationDefault?: string | undefined;
  /** Raw Accept-Language header value. */
  readonly acceptLanguage?: string | undefined;
  readonly marketDefault?: string | undefined;
}

export interface ResolvedLocale {
  readonly locale: SupportedLocale;
  readonly source: 'USER' | 'ORGANIZATION' | 'BROWSER' | 'MARKET' | 'DEFAULT';
}

/**
 * Language resolution, in the order from the spec:
 *   user preference → organization preference → browser locale → market default → global default.
 */
export function resolveLocale(signals: LocaleSignals): ResolvedLocale {
  const user = normalizeLocale(signals.userPreference);
  if (user) return { locale: user, source: 'USER' };

  const organization = normalizeLocale(signals.organizationDefault);
  if (organization) return { locale: organization, source: 'ORGANIZATION' };

  const browser = parseAcceptLanguage(signals.acceptLanguage);
  if (browser) return { locale: browser, source: 'BROWSER' };

  const market = normalizeLocale(signals.marketDefault);
  if (market) return { locale: market, source: 'MARKET' };

  return { locale: DEFAULT_LOCALE, source: 'DEFAULT' };
}

/** Maps "de-AT" or "DE" onto a supported base language, or undefined. */
export function normalizeLocale(value: string | undefined): SupportedLocale | undefined {
  if (!value) return undefined;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  return base && isSupportedLocale(base) ? base : undefined;
}

/** Picks the highest-weighted supported language from an Accept-Language header. */
export function parseAcceptLanguage(header: string | undefined): SupportedLocale | undefined {
  if (!header) return undefined;
  const entries = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const qParam = params.find((param) => param.trim().startsWith('q='));
      const quality = qParam ? Number.parseFloat(qParam.split('=')[1] ?? '0') : 1;
      return { tag: (tag ?? '').trim(), quality: Number.isFinite(quality) ? quality : 0 };
    })
    .filter((entry) => entry.tag.length > 0 && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality);

  for (const entry of entries) {
    const locale = normalizeLocale(entry.tag);
    if (locale) return locale;
  }
  return undefined;
}

export function localeToBcp47(locale: SupportedLocale, countryCode?: string): LocaleCode {
  return countryCode ? `${locale}-${countryCode.toUpperCase()}` : locale;
}
