import { DEFAULT_LOCALE, type SupportedLocale } from './locales.js';
import { CATALOGS, REFERENCE_CATALOG, type MessageKey } from './messages/index.js';

export type MessageValues = Readonly<Record<string, string | number>>;

/**
 * Message lookup with a per-key fallback to English.
 *
 * Deliberately not a full ICU MessageFormat implementation. Placeholders are `{name}` and are
 * substituted literally; plural and gender selection are handled by picking a different key
 * (`x.one` / `x.other`) chosen with Intl.PluralRules, which keeps catalogs readable for
 * non-technical translators and avoids shipping a formatting engine to the worker portal.
 */
export class Translator {
  private readonly catalog: Partial<Record<MessageKey, string>>;

  constructor(
    public readonly locale: SupportedLocale = DEFAULT_LOCALE,
    private readonly onMissing?: (key: MessageKey, locale: SupportedLocale) => void,
  ) {
    this.catalog = CATALOGS[locale] ?? {};
  }

  t(key: MessageKey, values?: MessageValues): string {
    let template = this.catalog[key];
    if (template === undefined) {
      this.onMissing?.(key, this.locale);
      template = REFERENCE_CATALOG[key];
    }
    return interpolate(template, values);
  }

  /**
   * Plural-aware lookup. Given base key `x`, looks for `x.one`, `x.few`, `x.other`… according
   * to the locale's plural rules, then falls back to `x.other`.
   */
  plural(baseKey: string, count: number, values?: MessageValues): string {
    const category = new Intl.PluralRules(this.locale).select(count);
    const candidates = [`${baseKey}.${category}`, `${baseKey}.other`] as unknown as MessageKey[];
    for (const candidate of candidates) {
      if (this.catalog[candidate] !== undefined || REFERENCE_CATALOG[candidate] !== undefined) {
        return this.t(candidate, { count, ...values });
      }
    }
    return `${baseKey}.other`;
  }

  /** True when the key is translated in this locale rather than falling back. */
  has(key: MessageKey): boolean {
    return this.catalog[key] !== undefined;
  }
}

export function interpolate(template: string, values?: MessageValues): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Turns a DomainError code into a message key.
 *
 * This is the bridge that lets business logic stay free of user-facing strings: services throw
 * `new ConflictError('shift.already_active', ...)`, and the presentation layer looks the code up
 * here. An unmapped code degrades to a generic message rather than leaking English internals.
 */
export function messageKeyForErrorCode(code: string): MessageKey {
  return (code in REFERENCE_CATALOG ? code : 'error.generic') as MessageKey;
}
