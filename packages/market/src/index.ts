/**
 * @aytracker/market — market resolution, currency presentation and tax computation.
 *
 * Pure logic. Market rows come from the database, but this package never reads them itself:
 * the caller loads them and constructs a MarketResolver, which keeps the resolution rules
 * testable without a database.
 */

export * from './types.js';
export * from './market-resolver.js';
export * from './currency-service.js';
export * from './tax-service.js';
