import { addMoney, multiplyMoney, money, ValidationError } from '@aytracker/domain';
import type { CountryCode, Money } from '@aytracker/types';
import type { TaxScheme } from './types.js';

/**
 * Tax computation.
 *
 * Scope and honesty about it: this computes EU VAT for a SaaS subscription sold by an EU seller,
 * including the B2B reverse charge, from a rate table. It does NOT compute US sales tax — US
 * nexus and rate sourcing are a provider problem (Stripe Tax, Avalara), so `US_SALES_TAX`
 * returns a deferral marker instead of a number, and the billing service routes those to the
 * provider. Returning a wrong US number would be worse than returning none.
 *
 * Nothing here ever runs in the browser.
 */

export interface TaxContext {
  /** Country the seller is established in. Configuration, not request data. */
  readonly sellerCountry: CountryCode;
  /** Customer's billing country — authoritative signal only. */
  readonly customerCountry: CountryCode;
  readonly scheme: TaxScheme;
  readonly isBusiness: boolean;
  /** True only when the VAT number has been validated against VIES and stored. */
  readonly hasValidatedVatNumber: boolean;
}

export type TaxTreatment =
  | 'STANDARD_RATE'
  | 'REVERSE_CHARGE'
  | 'OUT_OF_SCOPE'
  | 'ZERO_RATED'
  | 'DEFERRED_TO_PROVIDER';

export interface TaxResult {
  readonly treatment: TaxTreatment;
  /** Percentage points, e.g. 20 for 20 %. Zero when tax is not charged by us. */
  readonly ratePercent: number;
  readonly taxAmount: Money;
  readonly totalAmount: Money;
  /** Machine-readable reason, for the invoice footnote lookup. Never a user-facing string. */
  readonly reasonCode: string;
}

/** Standard VAT rates for EU member states. Data, not logic — updated by migration. */
export const EU_VAT_RATES: Readonly<Record<CountryCode, number>> = {
  AT: 20, BE: 21, BG: 20, HR: 25, CY: 19, CZ: 21, DK: 25, EE: 22,
  FI: 25.5, FR: 20, DE: 19, GR: 24, HU: 27, IE: 23, IT: 22, LV: 21,
  LT: 21, LU: 17, MT: 18, NL: 21, PL: 23, PT: 23, RO: 21, SK: 23,
  SI: 22, ES: 21, SE: 25,
};

export function isEuCountry(country: CountryCode): boolean {
  return country in EU_VAT_RATES;
}

export class TaxService {
  constructor(private readonly rates: Readonly<Record<CountryCode, number>> = EU_VAT_RATES) {}

  /**
   * @param netAmount Amount excluding tax.
   * @param context   Must be built from authoritative billing data. Passing an IP-derived
   *                  country here is a bug — see MarketResolver.isTaxAuthoritative.
   */
  calculate(netAmount: Money, context: TaxContext): TaxResult {
    switch (context.scheme) {
      case 'NONE':
        return this.noTax(netAmount, 'OUT_OF_SCOPE', 'tax.scheme_none');
      case 'US_SALES_TAX':
        return this.noTax(netAmount, 'DEFERRED_TO_PROVIDER', 'tax.us_provider_calculated');
      case 'EU_VAT':
        return this.calculateEuVat(netAmount, context);
    }
  }

  private calculateEuVat(netAmount: Money, context: TaxContext): TaxResult {
    const seller = context.sellerCountry.toUpperCase();
    const customer = context.customerCountry.toUpperCase();

    if (!isEuCountry(seller)) {
      throw new ValidationError(
        'tax.seller_not_eu',
        `EU VAT scheme requires an EU seller country, got ${seller}.`,
      );
    }

    // Outside the EU: a B2B digital service to a non-EU business is outside the scope of EU VAT.
    if (!isEuCountry(customer)) {
      return this.noTax(netAmount, 'OUT_OF_SCOPE', 'tax.eu_export_out_of_scope');
    }

    // Cross-border B2B inside the EU with a validated VAT number: the customer accounts for it.
    if (customer !== seller && context.isBusiness && context.hasValidatedVatNumber) {
      return this.noTax(netAmount, 'REVERSE_CHARGE', 'tax.eu_reverse_charge');
    }

    // Everything else — domestic sales, and cross-border sales without a validated VAT number —
    // is charged at the customer's country rate under the destination principle.
    const rate = this.rates[customer];
    if (rate === undefined) {
      throw new ValidationError('tax.missing_rate', `No VAT rate configured for ${customer}.`);
    }
    const taxAmount = multiplyMoney(netAmount, (rate / 100).toFixed(6));
    return {
      treatment: 'STANDARD_RATE',
      ratePercent: rate,
      taxAmount,
      totalAmount: addMoney(netAmount, taxAmount),
      reasonCode: customer === seller ? 'tax.eu_domestic' : 'tax.eu_destination_rate',
    };
  }

  private noTax(netAmount: Money, treatment: TaxTreatment, reasonCode: string): TaxResult {
    return {
      treatment,
      ratePercent: 0,
      taxAmount: money('0', netAmount.currency),
      totalAmount: netAmount,
      reasonCode,
    };
  }
}
