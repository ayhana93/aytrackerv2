import type {
  CountryCode,
  CurrencyCode,
  LocaleCode,
  MeasurementSystem,
  TimezoneId,
} from '@aytracker/types';

export type TaxScheme = 'NONE' | 'EU_VAT' | 'US_SALES_TAX';

export interface Market {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly countryCodes: readonly CountryCode[];
  readonly defaultCurrency: CurrencyCode;
  readonly defaultLocale: LocaleCode;
  readonly defaultTimezone: TimezoneId;
  readonly measurementSystem: MeasurementSystem;
  readonly taxScheme: TaxScheme;
  readonly blockedFeatures: readonly string[];
  readonly isActive: boolean;
  readonly priority: number;
}

/**
 * Where a resolved market came from. Ordered by trust, highest first — this is the priority
 * chain from docs/market-pricing.md, encoded so it can be tested and logged.
 */
export type MarketSignalSource =
  | 'ORGANIZATION_BILLING_COUNTRY'
  | 'CUSTOMER_BILLING_COUNTRY'
  | 'USER_SELECTED'
  | 'IP_GEOLOCATION'
  | 'BROWSER_LOCALE'
  | 'DEFAULT';

export const MARKET_SIGNAL_PRIORITY: readonly MarketSignalSource[] = [
  'ORGANIZATION_BILLING_COUNTRY',
  'CUSTOMER_BILLING_COUNTRY',
  'USER_SELECTED',
  'IP_GEOLOCATION',
  'BROWSER_LOCALE',
  'DEFAULT',
];

/**
 * Signals that may be used for *tax* decisions. Everything below this line is a display and
 * pricing hint only: an IP address is not proof of tax residency, and a customer must not be
 * able to obtain another country's rate by changing one.
 */
export const TAX_AUTHORITATIVE_SOURCES: ReadonlySet<MarketSignalSource> = new Set([
  'ORGANIZATION_BILLING_COUNTRY',
  'CUSTOMER_BILLING_COUNTRY',
]);

export interface MarketSignals {
  /** Billing country of the authenticated organization. Server-read, never client-supplied. */
  readonly organizationBillingCountry?: CountryCode | undefined;
  /** Billing country on the billing customer record, when it differs from the organization. */
  readonly customerBillingCountry?: CountryCode | undefined;
  /** Explicit market chosen by a visitor on the pricing page. Display only. */
  readonly userSelectedMarketCode?: string | undefined;
  /** Country from server-side IP geolocation. Display only. */
  readonly ipCountry?: CountryCode | undefined;
  /** Accept-Language / timezone hints. Weakest signal. */
  readonly browserLocale?: LocaleCode | undefined;
}

export interface ResolvedMarket {
  readonly market: Market;
  readonly source: MarketSignalSource;
  /**
   * True when the source is authoritative enough to drive tax treatment. False means the
   * resolution may set displayed prices but must not be used to compute or charge VAT.
   */
  readonly isTaxAuthoritative: boolean;
  /** Every signal considered, for audit and support. */
  readonly consideredSignals: readonly {
    readonly source: MarketSignalSource;
    readonly value: string | undefined;
    readonly matchedMarketCode: string | null;
  }[];
}
