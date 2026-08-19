import { bg } from './bg.js';
import { de } from './de.js';
import { en, type MessageCatalog, type MessageKey } from './en.js';
import type { SupportedLocale } from '../locales.js';

/**
 * Catalog registry.
 *
 * `en`, `bg` and `de` are complete and typed as full catalogs — a missing key will not compile.
 *
 * `ro`, `pl` and `cs` are declared and wired end to end, but their catalogs are partial and
 * awaiting native review. Every untranslated key falls back to English at lookup time, so those
 * locales are usable rather than broken, and `catalogCoverage()` reports exactly how complete
 * each one is. Shipping a half-guessed Polish UI as if it were finished would be worse than an
 * English fallback a customer can read; the coverage report is what turns that from a silent
 * gap into a tracked one.
 */

const ro: Partial<MessageCatalog> = {
  'common.save': 'Salvează',
  'common.cancel': 'Anulează',
  'common.confirm': 'Confirmă',
  'auth.login': 'Autentificare',
  'auth.logout': 'Deconectare',
  'auth.employee_number': 'Număr de angajat',
  'auth.pin': 'PIN',
  'auth.welcome': 'Bine ați venit',
  'shift.start': 'Începe tura',
  'shift.end': 'Încheie tura',
  'position.change': 'Schimbă postul',
  'position.current': 'Post curent',
};

const pl: Partial<MessageCatalog> = {
  'common.save': 'Zapisz',
  'common.cancel': 'Anuluj',
  'common.confirm': 'Potwierdź',
  'auth.login': 'Zaloguj się',
  'auth.logout': 'Wyloguj się',
  'auth.employee_number': 'Numer pracownika',
  'auth.pin': 'PIN',
  'auth.welcome': 'Witamy',
  'shift.start': 'Rozpocznij zmianę',
  'shift.end': 'Zakończ zmianę',
  'position.change': 'Zmień stanowisko',
  'position.current': 'Aktualne stanowisko',
};

const cs: Partial<MessageCatalog> = {
  'common.save': 'Uložit',
  'common.cancel': 'Zrušit',
  'common.confirm': 'Potvrdit',
  'auth.login': 'Přihlásit se',
  'auth.logout': 'Odhlásit se',
  'auth.employee_number': 'Osobní číslo',
  'auth.pin': 'PIN',
  'auth.welcome': 'Vítejte',
  'shift.start': 'Zahájit směnu',
  'shift.end': 'Ukončit směnu',
  'position.change': 'Změnit pracoviště',
  'position.current': 'Aktuální pracoviště',
};

export const CATALOGS: Readonly<Record<SupportedLocale, Partial<MessageCatalog>>> = {
  en,
  bg,
  de,
  ro,
  pl,
  cs,
};

export const REFERENCE_CATALOG: MessageCatalog = en;

export const ALL_MESSAGE_KEYS: readonly MessageKey[] = Object.keys(en) as MessageKey[];

export interface CatalogCoverage {
  readonly locale: SupportedLocale;
  readonly translated: number;
  readonly total: number;
  readonly percent: number;
  readonly missingKeys: readonly MessageKey[];
}

/** Coverage per locale. Used by the localization test and the admin diagnostics page. */
export function catalogCoverage(locale: SupportedLocale): CatalogCoverage {
  const catalog = CATALOGS[locale];
  const missingKeys = ALL_MESSAGE_KEYS.filter((key) => catalog[key] === undefined);
  const translated = ALL_MESSAGE_KEYS.length - missingKeys.length;
  return {
    locale,
    translated,
    total: ALL_MESSAGE_KEYS.length,
    percent: Math.round((translated / ALL_MESSAGE_KEYS.length) * 100),
    missingKeys,
  };
}

/** Locales considered production-complete. Used to decide what a language picker offers. */
export const COMPLETE_LOCALES: readonly SupportedLocale[] = ['en', 'bg', 'de'];

export { en, bg, de, ro, pl, cs };
export type { MessageCatalog, MessageKey };
