/**
 * @aytracker/tracking — geometry, tracking state and fuel arithmetic.
 *
 * Pure functions over plain data. No database, no HTTP, no vendor SDK — which is what makes
 * the distance, gap and fuel rules testable without a fixture the size of a trip.
 */

export * from './geo.js';
export * from './tracking-state.js';
export * from './fuel-calculator.js';
export * from './sampling.js';
export * from './routing-provider.js';
