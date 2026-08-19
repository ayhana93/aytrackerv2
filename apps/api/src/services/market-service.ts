import type { PrismaClient } from '@aytracker/database';
import {
  MarketResolver,
  type Market,
  type MarketSignals,
  type ResolvedMarket,
} from '@aytracker/market';
import { PricingCatalog, type PriceRecord } from '@aytracker/billing';
import type { CountryCode, OrganizationId } from '@aytracker/types';

/**
 * Loads markets and prices from the database and hands the pure resolvers their data.
 *
 * Cached for a few minutes: these tables change when someone edits pricing, not per request,
 * and a database round trip on every anonymous pricing-page view is wasted work.
 */
export class MarketService {
  private resolverCache: { resolver: MarketResolver; expiresAt: number } | null = null;
  private catalogCache: { catalog: PricingCatalog; expiresAt: number } | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly defaultMarketCode: string,
    private readonly ttlMs = 300_000,
  ) {}

  async resolver(): Promise<MarketResolver> {
    const now = Date.now();
    if (this.resolverCache && this.resolverCache.expiresAt > now) {
      return this.resolverCache.resolver;
    }

    const rows = await this.prisma.market.findMany({ where: { isActive: true } });
    const markets: Market[] = rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      countryCodes: row.countryCodes,
      defaultCurrency: row.defaultCurrency,
      defaultLocale: row.defaultLocale,
      defaultTimezone: row.defaultTimezone,
      measurementSystem: row.measurementSystem,
      taxScheme: row.taxScheme,
      blockedFeatures: row.blockedFeatures,
      isActive: row.isActive,
      priority: row.priority,
    }));

    const resolver = new MarketResolver(markets, this.defaultMarketCode);
    this.resolverCache = { resolver, expiresAt: now + this.ttlMs };
    return resolver;
  }

  async catalog(): Promise<PricingCatalog> {
    const now = Date.now();
    if (this.catalogCache && this.catalogCache.expiresAt > now) {
      return this.catalogCache.catalog;
    }

    const rows = await this.prisma.price.findMany({
      where: { status: { in: ['ACTIVE', 'GRANDFATHERED'] } },
      select: {
        id: true,
        planId: true,
        currency: true,
        interval: true,
        amount: true,
        status: true,
        effectiveFrom: true,
        effectiveTo: true,
        isPromotional: true,
        promotionCode: true,
        plan: { select: { code: true } },
        market: { select: { code: true } },
      },
    });

    const prices: PriceRecord[] = rows.map((row) => ({
      id: row.id,
      planId: row.planId,
      planCode: row.plan.code,
      marketCode: row.market.code,
      currency: row.currency,
      interval: row.interval,
      amount: row.amount.toString(),
      status: row.status,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      isPromotional: row.isPromotional,
      promotionCode: row.promotionCode,
    }));

    const catalog = new PricingCatalog(prices);
    this.catalogCache = { catalog, expiresAt: now + this.ttlMs };
    return catalog;
  }

  /**
   * Market for an anonymous visitor — the public pricing page.
   *
   * All signals here are weak by construction: a visitor's chosen market and their IP country
   * are display hints. The result is explicitly marked non-authoritative for tax, and no
   * charge is ever computed from it.
   */
  async resolveForVisitor(signals: MarketSignals): Promise<ResolvedMarket> {
    const resolver = await this.resolver();
    return resolver.resolve(signals);
  }

  /**
   * Market for an authenticated organization.
   *
   * Reads the billing country from the database and passes *only* that to the resolver. No
   * request-supplied signal reaches this path, which is what makes "a customer cannot obtain
   * another country's cheaper price" true rather than merely intended.
   */
  async resolveForOrganization(organizationId: OrganizationId): Promise<ResolvedMarket> {
    const [resolver, organization] = await Promise.all([
      this.resolver(),
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { billingCountry: true, billingCustomer: { select: { countryCode: true } } },
      }),
    ]);

    // The billing customer's country wins when it exists: it is the address on the invoice.
    const country: CountryCode =
      organization?.billingCustomer?.countryCode ?? organization?.billingCountry ?? 'XX';
    return resolver.resolveForOrganization(country);
  }

  invalidate(): void {
    this.resolverCache = null;
    this.catalogCache = null;
  }
}

/**
 * Extracts market signals from a request.
 *
 * `ipCountry` comes from an edge header set by the proxy — never from a client-settable header
 * on a direct connection, which is why the trusted-header name is configuration.
 */
export function marketSignalsFromRequest(input: {
  headers: Record<string, string | string[] | undefined>;
  query: { market?: string | undefined };
  geoHeaderName: string | null;
}): MarketSignals {
  const geoHeader = input.geoHeaderName
    ? input.headers[input.geoHeaderName.toLowerCase()]
    : undefined;
  const ipCountry = Array.isArray(geoHeader) ? geoHeader[0] : geoHeader;
  const acceptLanguage = input.headers['accept-language'];

  return {
    userSelectedMarketCode: input.query.market,
    ipCountry: ipCountry?.toUpperCase(),
    browserLocale: Array.isArray(acceptLanguage) ? acceptLanguage[0] : acceptLanguage,
  };
}
