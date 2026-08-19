import { describe, expect, it } from 'vitest';
import { MarketResolver, TaxService, type Market } from '@aytracker/market';
import { PricingCatalog, type PriceRecord } from '@aytracker/billing';
import { money } from '@aytracker/domain';

/**
 * Market resolution and pricing.
 *
 * The property under test throughout: a customer must not be able to reach a cheaper market by
 * manipulating a request. Everything else here is in service of that.
 */

function market(overrides: Partial<Market> & Pick<Market, 'code'>): Market {
  return {
    id: `market-${overrides.code}`,
    name: overrides.code,
    countryCodes: [],
    defaultCurrency: 'EUR',
    defaultLocale: 'en',
    defaultTimezone: 'UTC',
    measurementSystem: 'METRIC',
    taxScheme: 'EU_VAT',
    blockedFeatures: [],
    isActive: true,
    priority: 100,
    ...overrides,
  };
}

const MARKETS: Market[] = [
  market({ code: 'GLOBAL', taxScheme: 'NONE', priority: 1000 }),
  market({ code: 'BG', countryCodes: ['BG'], defaultLocale: 'bg', priority: 10 }),
  market({ code: 'DE', countryCodes: ['DE'], defaultLocale: 'de', priority: 10 }),
  market({ code: 'EU', countryCodes: ['FR', 'PL', 'RO', 'DE'], priority: 50 }),
  market({
    code: 'US',
    countryCodes: ['US'],
    defaultCurrency: 'USD',
    taxScheme: 'US_SALES_TAX',
    measurementSystem: 'IMPERIAL',
    priority: 10,
  }),
];

describe('MarketResolver', () => {
  const resolver = new MarketResolver(MARKETS, 'GLOBAL');

  it('prefers the organization billing country above every other signal', () => {
    const result = resolver.resolve({
      organizationBillingCountry: 'BG',
      customerBillingCountry: 'DE',
      userSelectedMarketCode: 'US',
      ipCountry: 'US',
      browserLocale: 'en-US',
    });
    expect(result.market.code).toBe('BG');
    expect(result.source).toBe('ORGANIZATION_BILLING_COUNTRY');
    expect(result.isTaxAuthoritative).toBe(true);
  });

  it('falls to the customer billing country when the organization has none', () => {
    const result = resolver.resolve({ customerBillingCountry: 'DE', ipCountry: 'BG' });
    expect(result.market.code).toBe('DE');
    expect(result.isTaxAuthoritative).toBe(true);
  });

  it('uses a visitor’s explicit choice above their IP', () => {
    const result = resolver.resolve({ userSelectedMarketCode: 'BG', ipCountry: 'US' });
    expect(result.market.code).toBe('BG');
    expect(result.source).toBe('USER_SELECTED');
  });

  /** An IP is a display hint. It must never be usable as proof of tax residency. */
  it('marks an IP-derived market as not authoritative for tax', () => {
    const result = resolver.resolve({ ipCountry: 'DE' });
    expect(result.market.code).toBe('DE');
    expect(result.source).toBe('IP_GEOLOCATION');
    expect(result.isTaxAuthoritative).toBe(false);
  });

  it('marks a visitor-selected market as not authoritative for tax', () => {
    expect(resolver.resolve({ userSelectedMarketCode: 'BG' }).isTaxAuthoritative).toBe(false);
  });

  it('reads the region from a browser locale as the weakest signal', () => {
    const result = resolver.resolve({ browserLocale: 'de-DE' });
    expect(result.market.code).toBe('DE');
    expect(result.source).toBe('BROWSER_LOCALE');
  });

  it('falls back to the global market when nothing matches', () => {
    const result = resolver.resolve({ ipCountry: 'ZZ' });
    expect(result.market.code).toBe('GLOBAL');
    expect(result.source).toBe('DEFAULT');
  });

  /**
   * The core security test. `resolveForOrganization` accepts no signal a client can influence,
   * so an authenticated German customer cannot present themselves as Bulgarian.
   */
  it('resolveForOrganization ignores every client-influenced signal', () => {
    const result = resolver.resolveForOrganization('DE');
    expect(result.market.code).toBe('DE');
    expect(result.source).toBe('ORGANIZATION_BILLING_COUNTRY');
    expect(result.isTaxAuthoritative).toBe(true);
    // There is no parameter on this method through which BG could have been requested.
    expect(result.consideredSignals).toHaveLength(1);
  });

  it('gives the more specific market priority when two claim a country', () => {
    // DE appears in both the DE market (priority 10) and the EU market (priority 50).
    expect(resolver.marketByCountry('DE')?.code).toBe('DE');
    expect(resolver.marketByCountry('FR')?.code).toBe('EU');
  });

  it('records every signal it considered, for support and audit', () => {
    const result = resolver.resolve({ ipCountry: 'BG', browserLocale: 'de-DE' });
    const sources = result.consideredSignals.map((signal) => signal.source);
    expect(sources).toContain('ORGANIZATION_BILLING_COUNTRY');
    expect(sources).toContain('IP_GEOLOCATION');
  });

  it('refuses to construct without a usable fallback market', () => {
    expect(() => new MarketResolver([market({ code: 'BG' })], 'GLOBAL')).toThrowError(
      /fallback market/i,
    );
  });
});

describe('PricingCatalog', () => {
  const from = new Date('2026-01-01T00:00:00Z');
  const prices: PriceRecord[] = [
    {
      id: 'bg-starter-monthly',
      planId: 'plan-starter',
      planCode: 'starter',
      marketCode: 'BG',
      currency: 'EUR',
      interval: 'MONTHLY',
      amount: '49',
      status: 'ACTIVE',
      effectiveFrom: from,
      effectiveTo: null,
      isPromotional: false,
      promotionCode: null,
    },
    {
      id: 'bg-starter-annual',
      planId: 'plan-starter',
      planCode: 'starter',
      marketCode: 'BG',
      currency: 'EUR',
      interval: 'ANNUAL',
      amount: '490',
      status: 'ACTIVE',
      effectiveFrom: from,
      effectiveTo: null,
      isPromotional: false,
      promotionCode: null,
    },
    {
      id: 'de-starter-monthly',
      planId: 'plan-starter',
      planCode: 'starter',
      marketCode: 'DE',
      currency: 'EUR',
      interval: 'MONTHLY',
      amount: '69',
      status: 'ACTIVE',
      effectiveFrom: from,
      effectiveTo: null,
      isPromotional: false,
      promotionCode: null,
    },
    {
      id: 'bg-starter-founding',
      planId: 'plan-starter',
      planCode: 'starter',
      marketCode: 'BG',
      currency: 'EUR',
      interval: 'MONTHLY',
      amount: '29',
      status: 'ACTIVE',
      effectiveFrom: from,
      effectiveTo: null,
      isPromotional: true,
      promotionCode: 'FOUNDING',
    },
    {
      id: 'bg-starter-old',
      planId: 'plan-starter',
      planCode: 'starter',
      marketCode: 'BG',
      currency: 'EUR',
      interval: 'MONTHLY',
      amount: '39',
      status: 'GRANDFATHERED',
      effectiveFrom: new Date('2025-01-01T00:00:00Z'),
      effectiveTo: from,
      isPromotional: false,
      promotionCode: null,
    },
  ];

  const catalog = new PricingCatalog(prices);
  const now = new Date('2026-06-01T00:00:00Z');

  it('sells the active price for a market', () => {
    const quote = catalog.requireSellable({
      marketCode: 'BG',
      planCode: 'starter',
      interval: 'MONTHLY',
      at: now,
    });
    expect(quote.net).toEqual(money('49', 'EUR'));
  });

  it('prices the same plan differently in another market', () => {
    const quote = catalog.requireSellable({
      marketCode: 'DE',
      planCode: 'starter',
      interval: 'MONTHLY',
      at: now,
    });
    expect(quote.net.amount).toBe('69.00');
  });

  /** A promotional price must never leak into the public list or a plain lookup. */
  it('never returns a promotional price from a plain lookup', () => {
    const quote = catalog.requireSellable({
      marketCode: 'BG',
      planCode: 'starter',
      interval: 'MONTHLY',
      at: now,
    });
    expect(quote.price.id).toBe('bg-starter-monthly');
    expect(catalog.listForMarket('BG', now).map((entry) => entry.price.id)).not.toContain(
      'bg-starter-founding',
    );
  });

  it('returns a promotional price only when its code is presented', () => {
    const quote = catalog.findPromotional({
      marketCode: 'BG',
      planCode: 'starter',
      interval: 'MONTHLY',
      promotionCode: 'FOUNDING',
      at: now,
    });
    expect(quote?.net.amount).toBe('29.00');
    expect(
      catalog.findPromotional({
        marketCode: 'BG',
        planCode: 'starter',
        interval: 'MONTHLY',
        promotionCode: 'WRONG',
        at: now,
      }),
    ).toBeNull();
  });

  /**
   * Grandfathering: a retired price is still resolvable by id, so a customer sold at €39 keeps
   * paying €39 after the list price moves to €49.
   */
  it('still resolves a grandfathered price by id', () => {
    const quote = catalog.findById('bg-starter-old');
    expect(quote?.net.amount).toBe('39.00');
  });

  it('does not sell a grandfathered price to a new customer', () => {
    const sellable = catalog.findSellable({
      marketCode: 'BG',
      planCode: 'starter',
      interval: 'MONTHLY',
      at: now,
    });
    expect(sellable?.price.id).not.toBe('bg-starter-old');
  });

  it('throws when a market has no price for a plan', () => {
    expect(() =>
      catalog.requireSellable({
        marketCode: 'US',
        planCode: 'starter',
        interval: 'MONTHLY',
        at: now,
      }),
    ).toThrowError(/no active price/i);
  });

  it('computes the annual saving', () => {
    // 490 vs 12 × 49 = 588 → 17 %
    expect(catalog.annualSavingPercent('BG', 'starter', now)).toBe(17);
  });
});

describe('TaxService', () => {
  const tax = new TaxService();
  const net = money('100', 'EUR');

  it('charges domestic VAT at the seller’s own rate', () => {
    const result = tax.calculate(net, {
      sellerCountry: 'BG',
      customerCountry: 'BG',
      scheme: 'EU_VAT',
      isBusiness: true,
      hasValidatedVatNumber: false,
    });
    expect(result.treatment).toBe('STANDARD_RATE');
    expect(result.ratePercent).toBe(20);
    expect(result.taxAmount.amount).toBe('20.00');
    expect(result.totalAmount.amount).toBe('120.00');
  });

  it('applies the reverse charge for validated cross-border EU B2B', () => {
    const result = tax.calculate(net, {
      sellerCountry: 'BG',
      customerCountry: 'DE',
      scheme: 'EU_VAT',
      isBusiness: true,
      hasValidatedVatNumber: true,
    });
    expect(result.treatment).toBe('REVERSE_CHARGE');
    expect(result.taxAmount.amount).toBe('0.00');
    expect(result.totalAmount.amount).toBe('100.00');
  });

  /**
   * Without a validated VAT number there is no reverse charge — the destination rate applies.
   * Claiming to be a business is not the same as being one.
   */
  it('charges the destination rate when the VAT number is not validated', () => {
    const result = tax.calculate(net, {
      sellerCountry: 'BG',
      customerCountry: 'DE',
      scheme: 'EU_VAT',
      isBusiness: true,
      hasValidatedVatNumber: false,
    });
    expect(result.treatment).toBe('STANDARD_RATE');
    expect(result.ratePercent).toBe(19);
    expect(result.taxAmount.amount).toBe('19.00');
  });

  it('treats a non-EU sale as out of scope', () => {
    const result = tax.calculate(net, {
      sellerCountry: 'BG',
      customerCountry: 'US',
      scheme: 'EU_VAT',
      isBusiness: true,
      hasValidatedVatNumber: false,
    });
    expect(result.treatment).toBe('OUT_OF_SCOPE');
  });

  /** US sales tax is deferred to the provider rather than guessed. */
  it('defers US sales tax to the payment provider', () => {
    const result = tax.calculate(money('100', 'USD'), {
      sellerCountry: 'BG',
      customerCountry: 'US',
      scheme: 'US_SALES_TAX',
      isBusiness: true,
      hasValidatedVatNumber: false,
    });
    expect(result.treatment).toBe('DEFERRED_TO_PROVIDER');
    expect(result.taxAmount.amount).toBe('0.00');
    expect(result.totalAmount.amount).toBe('100.00');
  });

  it('rounds tax to the currency’s minor unit', () => {
    const result = tax.calculate(money('89', 'EUR'), {
      sellerCountry: 'BG',
      customerCountry: 'BG',
      scheme: 'EU_VAT',
      isBusiness: true,
      hasValidatedVatNumber: false,
    });
    expect(result.taxAmount.amount).toBe('17.80');
    expect(result.totalAmount.amount).toBe('106.80');
  });
});
