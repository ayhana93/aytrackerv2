import { ValidationError } from '@aytracker/domain';
import type { CountryCode } from '@aytracker/types';
import {
  MARKET_SIGNAL_PRIORITY,
  TAX_AUTHORITATIVE_SOURCES,
  type Market,
  type MarketSignalSource,
  type MarketSignals,
  type ResolvedMarket,
} from './types.js';

export const GLOBAL_MARKET_CODE = 'GLOBAL';

/**
 * Resolves which commercial market a request belongs to.
 *
 * The entire security property of market pricing lives here: signals are consulted in a fixed
 * priority order, and the two signals a customer can influence (their own market selection,
 * their IP) rank *below* the billing country the server holds. A visitor may look at Bulgarian
 * prices from a German IP; a German organization is charged German prices regardless of what
 * their browser claims.
 */
export class MarketResolver {
  private readonly byCode = new Map<string, Market>();
  private readonly byCountry = new Map<CountryCode, Market>();
  private readonly fallback: Market;

  constructor(markets: readonly Market[], fallbackCode: string = GLOBAL_MARKET_CODE) {
    const active = markets.filter((market) => market.isActive);
    for (const market of active) {
      this.byCode.set(market.code, market);
    }
    // Lower `priority` wins when two markets claim the same country.
    for (const market of [...active].sort((a, b) => a.priority - b.priority)) {
      for (const country of market.countryCodes) {
        if (!this.byCountry.has(country)) {
          this.byCountry.set(country, market);
        }
      }
    }
    const fallback = this.byCode.get(fallbackCode);
    if (!fallback) {
      throw new ValidationError(
        'market.missing_fallback',
        `Fallback market "${fallbackCode}" is not an active market.`,
      );
    }
    this.fallback = fallback;
  }

  resolve(signals: MarketSignals): ResolvedMarket {
    const considered: ResolvedMarket['consideredSignals'][number][] = [];
    let chosen: { market: Market; source: MarketSignalSource } | null = null;

    for (const source of MARKET_SIGNAL_PRIORITY) {
      const value = this.signalValue(signals, source);
      const match = value === undefined ? null : this.matchSignal(source, value);
      considered.push({ source, value, matchedMarketCode: match?.code ?? null });
      if (match && !chosen) {
        chosen = { market: match, source };
      }
    }

    const result = chosen ?? { market: this.fallback, source: 'DEFAULT' as const };
    return {
      market: result.market,
      source: result.source,
      isTaxAuthoritative: TAX_AUTHORITATIVE_SOURCES.has(result.source),
      consideredSignals: considered,
    };
  }

  /**
   * Resolution for an authenticated organization. Deliberately narrower than `resolve`: it
   * ignores every client-influenced signal, so no request parameter can move an organization
   * onto a cheaper market.
   */
  resolveForOrganization(billingCountry: CountryCode): ResolvedMarket {
    const market = this.byCountry.get(normalizeCountry(billingCountry));
    const source: MarketSignalSource = market ? 'ORGANIZATION_BILLING_COUNTRY' : 'DEFAULT';
    return {
      market: market ?? this.fallback,
      source,
      isTaxAuthoritative: TAX_AUTHORITATIVE_SOURCES.has(source),
      consideredSignals: [
        {
          source: 'ORGANIZATION_BILLING_COUNTRY',
          value: billingCountry,
          matchedMarketCode: market?.code ?? null,
        },
      ],
    };
  }

  marketByCode(code: string): Market | undefined {
    return this.byCode.get(code);
  }

  marketByCountry(country: CountryCode): Market | undefined {
    return this.byCountry.get(normalizeCountry(country));
  }

  listMarkets(): readonly Market[] {
    return [...this.byCode.values()];
  }

  private signalValue(signals: MarketSignals, source: MarketSignalSource): string | undefined {
    switch (source) {
      case 'ORGANIZATION_BILLING_COUNTRY':
        return signals.organizationBillingCountry;
      case 'CUSTOMER_BILLING_COUNTRY':
        return signals.customerBillingCountry;
      case 'USER_SELECTED':
        return signals.userSelectedMarketCode;
      case 'IP_GEOLOCATION':
        return signals.ipCountry;
      case 'BROWSER_LOCALE':
        return signals.browserLocale;
      case 'DEFAULT':
        return undefined;
    }
  }

  private matchSignal(source: MarketSignalSource, value: string): Market | undefined {
    if (source === 'USER_SELECTED') {
      // A visitor picks a market by code from the list we published, not by country.
      return this.byCode.get(value.toUpperCase());
    }
    if (source === 'BROWSER_LOCALE') {
      const region = regionFromLocale(value);
      return region ? this.byCountry.get(region) : undefined;
    }
    return this.byCountry.get(normalizeCountry(value));
  }
}

export function normalizeCountry(value: string): CountryCode {
  return value.trim().toUpperCase();
}

/** Extracts the region subtag from a BCP 47 tag: "de-AT" → "AT", "bg" → undefined. */
export function regionFromLocale(locale: string): CountryCode | undefined {
  const parts = locale.split(/[-_]/);
  const region = parts.find((part) => /^[A-Za-z]{2}$/.test(part) && part === part.toUpperCase());
  return region ? region.toUpperCase() : undefined;
}
