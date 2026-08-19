import { NotFoundError, money } from '@aytracker/domain';
import type { CurrencyCode, Money } from '@aytracker/types';

export type BillingInterval = 'MONTHLY' | 'ANNUAL';
export type PriceStatus = 'DRAFT' | 'ACTIVE' | 'GRANDFATHERED' | 'RETIRED';

export interface PriceRecord {
  readonly id: string;
  readonly planId: string;
  readonly planCode: string;
  readonly marketCode: string;
  readonly currency: CurrencyCode;
  readonly interval: BillingInterval;
  /** Net amount, decimal string. */
  readonly amount: string;
  readonly status: PriceStatus;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly isPromotional: boolean;
  readonly promotionCode: string | null;
}

export interface PriceQuote {
  readonly price: PriceRecord;
  readonly net: Money;
}

/**
 * The pricing catalog.
 *
 * Prices are data. Adding a country means inserting rows; it never means touching this class.
 * Three properties matter, and each is a test:
 *
 *   1. A price is chosen by (market, plan, interval) — never by anything the client sends
 *      beyond a plan code.
 *   2. Only ACTIVE rows inside their effective window are sellable. GRANDFATHERED rows are
 *      still honoured for the subscriptions already pointing at them, but never offered.
 *   3. A promotional row is never returned by a plain lookup; it must be asked for by code.
 */
export class PricingCatalog {
  private readonly prices: readonly PriceRecord[];

  constructor(prices: readonly PriceRecord[]) {
    this.prices = prices;
  }

  /** The price a new customer in this market would be sold at. */
  findSellable(input: {
    marketCode: string;
    planCode: string;
    interval: BillingInterval;
    at?: Date;
  }): PriceQuote | null {
    const at = input.at ?? new Date();
    const candidates = this.prices.filter(
      (price) =>
        price.marketCode === input.marketCode &&
        price.planCode === input.planCode &&
        price.interval === input.interval &&
        price.status === 'ACTIVE' &&
        !price.isPromotional &&
        isWithinWindow(price, at),
    );
    // Newest effective row wins if the data ever contains an overlap the DB index missed.
    const chosen = candidates.sort(
      (a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime(),
    )[0];
    return chosen ? { price: chosen, net: money(chosen.amount, chosen.currency) } : null;
  }

  requireSellable(input: {
    marketCode: string;
    planCode: string;
    interval: BillingInterval;
    at?: Date;
  }): PriceQuote {
    const quote = this.findSellable(input);
    if (!quote) {
      throw new NotFoundError(
        'pricing.no_active_price',
        `No active price for ${input.planCode} / ${input.marketCode} / ${input.interval}.`,
        { details: { ...input } },
      );
    }
    return quote;
  }

  /**
   * A promotional or founding price, resolved only when the customer presents its code.
   * Kept separate from findSellable so a promotion can never leak into the public price list.
   */
  findPromotional(input: {
    marketCode: string;
    planCode: string;
    interval: BillingInterval;
    promotionCode: string;
    at?: Date;
  }): PriceQuote | null {
    const at = input.at ?? new Date();
    const found = this.prices.find(
      (price) =>
        price.marketCode === input.marketCode &&
        price.planCode === input.planCode &&
        price.interval === input.interval &&
        price.isPromotional &&
        price.status === 'ACTIVE' &&
        price.promotionCode === input.promotionCode &&
        isWithinWindow(price, at),
    );
    return found ? { price: found, net: money(found.amount, found.currency) } : null;
  }

  /** Every publicly listable price for a market — what the pricing page renders. */
  listForMarket(marketCode: string, at: Date = new Date()): readonly PriceQuote[] {
    return this.prices
      .filter(
        (price) =>
          price.marketCode === marketCode &&
          price.status === 'ACTIVE' &&
          !price.isPromotional &&
          isWithinWindow(price, at),
      )
      .map((price) => ({ price, net: money(price.amount, price.currency) }));
  }

  /**
   * The price an existing subscription is actually charged.
   *
   * Resolved by id, never re-derived from the catalog: that is what makes a price change safe
   * for existing customers. A retired or grandfathered row still resolves here.
   */
  findById(priceId: string): PriceQuote | null {
    const found = this.prices.find((price) => price.id === priceId);
    return found ? { price: found, net: money(found.amount, found.currency) } : null;
  }

  /** Annual saving versus paying monthly, as whole percent. Null when either price is missing. */
  annualSavingPercent(marketCode: string, planCode: string, at: Date = new Date()): number | null {
    const monthly = this.findSellable({ marketCode, planCode, interval: 'MONTHLY', at });
    const annual = this.findSellable({ marketCode, planCode, interval: 'ANNUAL', at });
    if (!monthly || !annual) return null;
    const monthlyYear = Number(monthly.price.amount) * 12;
    if (monthlyYear <= 0) return null;
    const saving = (1 - Number(annual.price.amount) / monthlyYear) * 100;
    return Math.round(saving);
  }
}

function isWithinWindow(price: PriceRecord, at: Date): boolean {
  if (price.effectiveFrom.getTime() > at.getTime()) return false;
  if (price.effectiveTo !== null && price.effectiveTo.getTime() <= at.getTime()) return false;
  return true;
}
