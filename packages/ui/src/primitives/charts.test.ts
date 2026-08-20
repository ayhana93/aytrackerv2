import { describe, expect, it } from 'vitest';
import { kpiSentiment, niceCeiling } from './chart-math';

/**
 * The two pieces of chart logic that can be wrong without looking wrong.
 *
 * Both shipped incorrectly first. The axis had no ceiling rounding, so the top of the scale was
 * whatever the peak happened to be and the ticks were unreadable fractions. The KPI painted every
 * increase green, which told a fleet manager their fuel bill was improving while it climbed.
 */

describe('axis ceiling', () => {
  it.each([
    [1, 1],
    [7, 10],
    [12, 20],
    [23, 50],
    [46, 50],
    [146, 200],
    [1460, 2000],
    [0.4, 0.5],
  ])('rounds %s up to %s', (input, expected) => {
    expect(niceCeiling(input)).toBe(expected);
  });

  it('never returns a ceiling below the value it was given', () => {
    for (const value of [1, 3, 17, 99, 101, 999, 1001, 12_345]) {
      expect(niceCeiling(value)).toBeGreaterThanOrEqual(value);
    }
  });

  it('returns a positive scale for zero and negative input', () => {
    // An empty shift produces all-zero points. A zero-height axis would divide by zero and put
    // every line on the baseline of a chart with no scale at all.
    expect(niceCeiling(0)).toBeGreaterThan(0);
    expect(niceCeiling(-5)).toBeGreaterThan(0);
  });

  it('only ever returns 1, 2 or 5 times a power of ten', () => {
    for (const value of [3, 17, 46, 146, 780, 4321, 98_765]) {
      const ceiling = niceCeiling(value);
      const magnitude = 10 ** Math.floor(Math.log10(ceiling));
      expect([1, 2, 5, 10]).toContain(Math.round(ceiling / magnitude));
    }
  });
});

describe('kpi sentiment', () => {
  it('is good when the number moved the way it should', () => {
    expect(kpiSentiment(4.2, 'up')).toBe('up');
    expect(kpiSentiment(-1.8, 'down')).toBe('up');
  });

  it('is bad when it moved the other way', () => {
    expect(kpiSentiment(-2.1, 'up')).toBe('down');
    // The one that was wrong: a rising fuel bill is bad news and must not be painted green.
    expect(kpiSentiment(7.8, 'down')).toBe('down');
  });

  it('is neutral at zero, whichever direction is good', () => {
    expect(kpiSentiment(0, 'up')).toBe('flat');
    expect(kpiSentiment(0, 'down')).toBe('flat');
  });

  it('is neutral when there is nothing to compare against', () => {
    // A new site's first week has no previous period. Painting that grey is honest; painting it
    // green because `null > 0` is false would be an accident that reads as a claim.
    expect(kpiSentiment(null, 'up')).toBe('flat');
    expect(kpiSentiment(null, 'down')).toBe('flat');
  });
});
