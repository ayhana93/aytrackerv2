/**
 * The arithmetic behind the charts and the KPI card.
 *
 * Separated from the components because it is the part that can be wrong without looking wrong,
 * and a pure function is the only shape a test can pin down. The components import from here;
 * nothing here imports React.
 */

/**
 * The next round number at or above `value`.
 *
 * An axis topping out at 146 tells a reader nothing; one topping out at 200 gives them ticks they
 * can divide in their head. 1, 2 and 5 times a power of ten is the standard set for exactly that.
 *
 * Zero and negatives return 1: an all-zero shift is a real case, and a zero-height scale would
 * divide by zero and flatten every line onto a chart with no axis at all.
 */
export function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

export type Sentiment = 'up' | 'down' | 'flat';

/**
 * Whether a change is good news.
 *
 * Kept apart from the arrow, which only says which way the number went. A rise in output is good;
 * a rise in cost per kilometre is not, and a component that colours every increase green tells a
 * fleet manager their costs are improving while they climb.
 */
export function kpiSentiment(delta: number | null, goodDirection: 'up' | 'down'): Sentiment {
  if (delta === null || !Number.isFinite(delta) || delta === 0) return 'flat';
  const movement = delta > 0 ? 'up' : 'down';
  return movement === goodDirection ? 'up' : 'down';
}

export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
