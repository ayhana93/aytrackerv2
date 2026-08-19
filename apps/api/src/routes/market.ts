import type { FastifyPluginAsync } from 'fastify';
import { marketQuerySchema } from '@aytracker/validation';
import { TaxService } from '@aytracker/market';
import { marketSignalsFromRequest } from '../services/market-service.js';
import type { AppServices } from '../services/container.js';

/**
 * /api/v1/market — public pricing.
 *
 * The security property this route exists to demonstrate: an anonymous visitor's market comes
 * from weak signals and is labelled as such, while an authenticated organization's market comes
 * from the billing country on their record and ignores every request parameter. The same
 * endpoint serves both, and the difference is decided by whether a session is present — not by
 * anything the caller sends.
 */
export function marketRoutes(services: AppServices): FastifyPluginAsync {
  return async (app) => {
    const taxService = new TaxService();

    app.get('/', async (request) => {
      const query = marketQuerySchema.parse(request.query ?? {});

      const resolved = request.actor
        ? await services.markets.resolveForOrganization(request.actor.organizationId)
        : await services.markets.resolveForVisitor(
            marketSignalsFromRequest({
              headers: request.headers as Record<string, string | string[] | undefined>,
              query: { market: query.market },
              geoHeaderName:
                services.config.env.MARKET_GEOLOCATION_PROVIDER === 'cloudflare'
                  ? 'cf-ipcountry'
                  : null,
            }),
          );

      return {
        market: {
          code: resolved.market.code,
          name: resolved.market.name,
          currency: resolved.market.defaultCurrency,
          locale: resolved.market.defaultLocale,
          timezone: resolved.market.defaultTimezone,
          measurementSystem: resolved.market.measurementSystem,
        },
        source: resolved.source,
        // Exposed so the pricing page can say "prices shown for Germany — change" rather than
        // silently pretending its guess is authoritative.
        isTaxAuthoritative: resolved.isTaxAuthoritative,
      };
    });

    app.get('/pricing', async (request) => {
      const query = marketQuerySchema.parse(request.query ?? {});

      const resolved = request.actor
        ? await services.markets.resolveForOrganization(request.actor.organizationId)
        : await services.markets.resolveForVisitor(
            marketSignalsFromRequest({
              headers: request.headers as Record<string, string | string[] | undefined>,
              query: { market: query.market },
              geoHeaderName:
                services.config.env.MARKET_GEOLOCATION_PROVIDER === 'cloudflare'
                  ? 'cf-ipcountry'
                  : null,
            }),
          );

      const catalog = await services.markets.catalog();
      const quotes = catalog.listForMarket(resolved.market.code);

      return {
        market: resolved.market.code,
        currency: resolved.market.defaultCurrency,
        source: resolved.source,
        interval: query.interval,
        plans: quotes
          .filter((quote) => quote.price.interval === query.interval)
          .map((quote) => ({
            planCode: quote.price.planCode,
            priceId: quote.price.id,
            net: quote.net,
            interval: quote.price.interval,
            annualSavingPercent: catalog.annualSavingPercent(
              resolved.market.code,
              quote.price.planCode,
            ),
          })),
        /**
         * Tax is quoted only when the market resolution is authoritative. For an anonymous
         * visitor we show net prices and say tax is calculated at checkout — inventing a VAT
         * figure from an IP address would be a number we cannot stand behind.
         */
        tax: resolved.isTaxAuthoritative
          ? { calculated: true, scheme: resolved.market.taxScheme }
          : { calculated: false, note: 'tax.calculated_at_checkout' },
      };
    });

    /**
     * A quote for a specific plan, including tax.
     *
     * Requires a session: tax needs an authoritative billing country, which only an
     * authenticated organization has.
     */
    app.get('/quote', async (request) => {
      const actor = app.requireAuth(request);
      const query = marketQuerySchema.parse(request.query ?? {});
      const planCode = (request.query as { plan?: string }).plan ?? 'starter';

      const resolved = await services.markets.resolveForOrganization(actor.organizationId);
      const catalog = await services.markets.catalog();
      const quote = catalog.requireSellable({
        marketCode: resolved.market.code,
        planCode,
        interval: query.interval,
      });

      const customer = await services.billingCustomer(actor.organizationId);
      const tax = taxService.calculate(quote.net, {
        sellerCountry: services.sellerCountry,
        customerCountry: customer.countryCode,
        scheme: resolved.market.taxScheme,
        isBusiness: customer.isBusiness,
        hasValidatedVatNumber: customer.vatValidatedAt !== null,
      });

      return {
        planCode,
        priceId: quote.price.id,
        interval: query.interval,
        net: quote.net,
        tax: tax.taxAmount,
        total: tax.totalAmount,
        taxTreatment: tax.treatment,
        taxRatePercent: tax.ratePercent,
        reasonCode: tax.reasonCode,
      };
    });
  };
}
