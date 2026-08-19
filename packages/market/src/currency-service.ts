import { ValidationError, minorUnitExponent } from '@aytracker/domain';
import type { CurrencyCode, LocaleCode, Money } from '@aytracker/types';

/**
 * Currency presentation and validation.
 *
 * There is deliberately no FX conversion here. Prices are authored per market in the currency
 * that market is billed in; converting at display time would produce a number the customer is
 * not actually charged. If cross-currency reporting is ever needed it gets its own service with
 * an explicit rate source and rate date.
 */
export class CurrencyService {
  private readonly formatters = new Map<string, Intl.NumberFormat>();

  format(value: Money, locale: LocaleCode): string {
    const key = `${locale}|${value.currency}`;
    let formatter = this.formatters.get(key);
    if (!formatter) {
      formatter = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: value.currency,
        minimumFractionDigits: minorUnitExponent(value.currency),
        maximumFractionDigits: minorUnitExponent(value.currency),
      });
      this.formatters.set(key, formatter);
    }
    return formatter.format(Number(value.amount));
  }

  /** Formats without the currency symbol — for tables that carry the currency in the header. */
  formatAmount(value: Money, locale: LocaleCode): string {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: minorUnitExponent(value.currency),
      maximumFractionDigits: minorUnitExponent(value.currency),
    }).format(Number(value.amount));
  }

  assertSupported(currency: string): asserts currency is CurrencyCode {
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new ValidationError('currency.invalid', `Invalid ISO 4217 code: ${currency}`);
    }
    try {
      new Intl.NumberFormat('en', { style: 'currency', currency });
    } catch {
      throw new ValidationError('currency.unsupported', `Unsupported currency: ${currency}`);
    }
  }
}
