import { describe, expect, it } from 'vitest';
import {
  addMoney,
  compareMoney,
  divideHalfUp,
  fromMinorUnits,
  localDateString,
  localMinuteOfDay,
  mergedIntervalSeconds,
  money,
  multiplyDecimalsToMoney,
  multiplyMoney,
  subtractMoney,
  sumMoney,
  timezoneOffsetMinutes,
  toMinorUnits,
  zonedTimeToUtc,
} from '@aytracker/domain';
import {
  Translator,
  catalogCoverage,
  formatDistance,
  formatDuration,
  parseAcceptLanguage,
  resolveLocale,
  SUPPORTED_LOCALES,
  COMPLETE_LOCALES,
} from '@aytracker/localization';

describe('money', () => {
  it('parses and renders canonical amounts', () => {
    expect(money('49', 'EUR').amount).toBe('49.00');
    expect(money('49.5', 'EUR').amount).toBe('49.50');
    expect(money('0', 'EUR').amount).toBe('0.00');
  });

  /** The reason money is integer minor units: 0.1 + 0.2 must be 0.30, not 0.30000000000000004. */
  it('adds without floating-point drift', () => {
    expect(addMoney(money('0.1', 'EUR'), money('0.2', 'EUR')).amount).toBe('0.30');
    const cents = Array.from({ length: 100 }, () => money('0.01', 'EUR'));
    expect(sumMoney(cents, 'EUR').amount).toBe('1.00');
  });

  it('subtracts and compares', () => {
    expect(subtractMoney(money('100', 'EUR'), money('19.99', 'EUR')).amount).toBe('80.01');
    expect(compareMoney(money('10', 'EUR'), money('20', 'EUR'))).toBe(-1);
    expect(compareMoney(money('20', 'EUR'), money('20', 'EUR'))).toBe(0);
  });

  it('refuses to combine different currencies', () => {
    expect(() => addMoney(money('10', 'EUR'), money('10', 'USD'))).toThrowError(/cannot combine/i);
  });

  it('multiplies with half-up rounding at the minor unit', () => {
    // 62.4 L × €1.49 = 92.976 → 92.98
    expect(multiplyMoney(money('1.49', 'EUR'), '62.4').amount).toBe('92.98');
    // 100 × 0.195 = 19.5
    expect(multiplyMoney(money('100', 'EUR'), '0.195').amount).toBe('19.50');
    // Exact half rounds away from zero.
    expect(multiplyMoney(money('0.05', 'EUR'), '0.5').amount).toBe('0.03');
  });

  /**
   * `multiplyDecimalsToMoney` exists for the case `multiplyMoney` cannot serve: a unit price
   * carrying more decimals than the currency does. Rounding it to the minor unit first is
   * rounding the wrong number, and the error scales with the quantity.
   */
  it('multiplies two exact decimals and rounds only the result', () => {
    // 8.4 L × 1.759 = 14.7756 → 14.78. Rounding the price to 1.76 first gives 14.78 too, but…
    expect(multiplyDecimalsToMoney('1.759', '8.4', 'EUR').amount).toBe('14.78');
    // …at four hundred litres the two answers are a euro apart: 703.60 versus 704.00.
    expect(multiplyDecimalsToMoney('1.759', '400', 'EUR').amount).toBe('703.60');
    expect(multiplyMoney(money('1.76', 'EUR'), '400').amount).toBe('704.00');
  });

  it('accepts a price the currency itself could not hold', () => {
    // `money('0.2148', 'EUR')` throws; a kWh price with four decimals is ordinary.
    expect(multiplyDecimalsToMoney('0.2148', '1250', 'EUR').amount).toBe('268.50');
  });

  it('rounds a decimal product half away from zero', () => {
    expect(multiplyDecimalsToMoney('0.005', '1', 'EUR').amount).toBe('0.01');
    expect(multiplyDecimalsToMoney('-0.005', '1', 'EUR').amount).toBe('-0.01');
  });

  it('handles zero-decimal currencies', () => {
    expect(money('1500', 'JPY').amount).toBe('1500');
    expect(toMinorUnits('1500', 'JPY')).toBe(1500n);
    expect(fromMinorUnits(1500n, 'JPY').amount).toBe('1500');
  });

  it('handles three-decimal currencies', () => {
    expect(money('12.345', 'KWD').amount).toBe('12.345');
  });

  it('rejects excess precision rather than silently truncating', () => {
    expect(() => toMinorUnits('49.999', 'EUR')).toThrowError(/decimal places/i);
  });

  it('rejects a malformed amount', () => {
    expect(() => toMinorUnits('not-a-number', 'EUR')).toThrowError(/invalid money amount/i);
  });

  it('handles negative amounts', () => {
    expect(money('-5.25', 'EUR').amount).toBe('-5.25');
    expect(subtractMoney(money('5', 'EUR'), money('10', 'EUR')).amount).toBe('-5.00');
  });

  it('rounds halves away from zero', () => {
    expect(divideHalfUp(5n, 2n)).toBe(3n);
    expect(divideHalfUp(-5n, 2n)).toBe(-3n);
    expect(divideHalfUp(4n, 2n)).toBe(2n);
  });
});

describe('timezones', () => {
  it('reports the standard-time offset', () => {
    expect(timezoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'Europe/Sofia')).toBe(120);
    expect(timezoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'Europe/Berlin')).toBe(60);
    expect(timezoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-300);
  });

  it('reports the summer-time offset', () => {
    expect(timezoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'), 'Europe/Sofia')).toBe(180);
    expect(timezoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-240);
  });

  it('gives the local calendar date, not the UTC one', () => {
    // 22:30 UTC is already the next day in Sofia.
    expect(localDateString(new Date('2026-03-10T22:30:00Z'), 'Europe/Sofia')).toBe('2026-03-11');
    expect(localDateString(new Date('2026-03-10T22:30:00Z'), 'UTC')).toBe('2026-03-10');
    // …and still the previous day in New York.
    expect(localDateString(new Date('2026-03-11T02:30:00Z'), 'America/New_York')).toBe(
      '2026-03-10',
    );
  });

  it('gives the local minute of day', () => {
    expect(localMinuteOfDay(new Date('2026-03-10T04:00:00Z'), 'Europe/Sofia')).toBe(6 * 60);
  });

  it('resolves a local wall-clock time to the right instant', () => {
    expect(zonedTimeToUtc('2026-01-15', 6 * 60, 'Europe/Sofia').toISOString()).toBe(
      '2026-01-15T04:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-07-15', 6 * 60, 'Europe/Sofia').toISOString()).toBe(
      '2026-07-15T03:00:00.000Z',
    );
  });

  it('handles a month boundary in a timezone ahead of UTC', () => {
    expect(localDateString(new Date('2026-03-31T22:30:00Z'), 'Europe/Sofia')).toBe('2026-04-01');
  });

  it('rejects an unknown timezone rather than silently using UTC', () => {
    expect(() => timezoneOffsetMinutes(new Date(), 'Mars/Olympus_Mons')).toThrowError(
      /unknown iana timezone/i,
    );
  });
});

describe('mergedIntervalSeconds', () => {
  it('sums disjoint intervals', () => {
    expect(
      mergedIntervalSeconds([
        { start: new Date('2026-03-10T10:00:00Z'), end: new Date('2026-03-10T10:15:00Z') },
        { start: new Date('2026-03-10T12:00:00Z'), end: new Date('2026-03-10T12:30:00Z') },
      ]),
    ).toBe(45 * 60);
  });

  it('counts overlapping intervals once', () => {
    expect(
      mergedIntervalSeconds([
        { start: new Date('2026-03-10T10:00:00Z'), end: new Date('2026-03-10T10:30:00Z') },
        { start: new Date('2026-03-10T10:10:00Z'), end: new Date('2026-03-10T10:20:00Z') },
      ]),
    ).toBe(30 * 60);
  });

  it('merges touching intervals', () => {
    expect(
      mergedIntervalSeconds([
        { start: new Date('2026-03-10T10:00:00Z'), end: new Date('2026-03-10T10:30:00Z') },
        { start: new Date('2026-03-10T10:30:00Z'), end: new Date('2026-03-10T11:00:00Z') },
      ]),
    ).toBe(60 * 60);
  });

  it('ignores zero-length and inverted intervals', () => {
    expect(
      mergedIntervalSeconds([
        { start: new Date('2026-03-10T10:00:00Z'), end: new Date('2026-03-10T10:00:00Z') },
        { start: new Date('2026-03-10T11:00:00Z'), end: new Date('2026-03-10T10:00:00Z') },
      ]),
    ).toBe(0);
  });
});

describe('localization', () => {
  it('resolves the user preference above everything else', () => {
    expect(
      resolveLocale({
        userPreference: 'bg',
        organizationDefault: 'de',
        acceptLanguage: 'en-US',
        marketDefault: 'en',
      }),
    ).toEqual({ locale: 'bg', source: 'USER' });
  });

  it('falls through the priority chain', () => {
    expect(resolveLocale({ organizationDefault: 'de', acceptLanguage: 'en' }).source).toBe(
      'ORGANIZATION',
    );
    expect(resolveLocale({ acceptLanguage: 'pl-PL' })).toEqual({ locale: 'pl', source: 'BROWSER' });
    expect(resolveLocale({ marketDefault: 'cs' })).toEqual({ locale: 'cs', source: 'MARKET' });
    expect(resolveLocale({})).toEqual({ locale: 'en', source: 'DEFAULT' });
  });

  it('ignores an unsupported language', () => {
    expect(resolveLocale({ userPreference: 'fr' }).source).toBe('DEFAULT');
  });

  it('picks the highest-weighted supported language from Accept-Language', () => {
    expect(parseAcceptLanguage('fr-FR,fr;q=0.9,de;q=0.8,en;q=0.7')).toBe('de');
    expect(parseAcceptLanguage('fr;q=0.9,ja;q=0.8')).toBeUndefined();
    expect(parseAcceptLanguage(undefined)).toBeUndefined();
  });

  it('maps a regional tag onto its base language', () => {
    expect(resolveLocale({ userPreference: 'de-AT' })).toEqual({ locale: 'de', source: 'USER' });
  });

  it('falls back to English for an untranslated key', () => {
    const translator = new Translator('pl');
    // 'common.save' is translated in Polish…
    expect(translator.t('common.save')).toBe('Zapisz');
    // …and this one is not, so English shows rather than a missing-key marker.
    expect(translator.t('tracking.event.app_not_reporting')).toBe('App no longer reporting');
    expect(translator.has('tracking.event.app_not_reporting')).toBe(false);
  });

  it('interpolates placeholders', () => {
    const translator = new Translator('en');
    expect(translator.t('auth.account_locked', { seconds: 60 })).toBe(
      'Too many attempts. Try again in 60 seconds.',
    );
  });

  it('leaves an unknown placeholder intact rather than printing undefined', () => {
    const translator = new Translator('en');
    expect(translator.t('auth.account_locked', {})).toContain('{seconds}');
  });

  it('reports 100 % coverage for the complete locales', () => {
    for (const locale of COMPLETE_LOCALES) {
      expect(catalogCoverage(locale).percent).toBe(100);
    }
  });

  /**
   * ro/pl/cs are declared but partial, awaiting native review. The test asserts the state we
   * actually shipped rather than pretending they are done.
   */
  it('reports partial coverage for locales awaiting translation', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const coverage = catalogCoverage(locale);
      if (COMPLETE_LOCALES.includes(locale)) continue;
      expect(coverage.percent).toBeLessThan(100);
      expect(coverage.missingKeys.length).toBeGreaterThan(0);
    }
  });

  it('formats a duration in the locale', () => {
    expect(formatDuration(7 * 3600 + 32 * 60, 'en')).toContain('7');
    expect(formatDuration(45 * 60, 'en')).toContain('45');
  });

  it('formats distance in the organization measurement system', () => {
    expect(formatDistance(148_000, 'en', 'METRIC')).toContain('148');
    expect(formatDistance(148_000, 'en', 'IMPERIAL')).toContain('92');
  });
});
