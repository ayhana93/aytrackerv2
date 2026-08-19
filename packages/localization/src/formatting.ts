import type { LocaleCode, MeasurementSystem, TimezoneId } from '@aytracker/types';

/**
 * Locale-aware presentation.
 *
 * All of it is Intl-based, which means date, number and unit formats follow the locale without
 * a per-country lookup table anywhere in the codebase.
 */

export function formatDate(
  instant: Date,
  locale: LocaleCode,
  timezone: TimezoneId,
  style: 'short' | 'medium' | 'long' = 'medium',
): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: style, timeZone: timezone }).format(instant);
}

export function formatTime(instant: Date, locale: LocaleCode, timezone: TimezoneId): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(instant);
}

export function formatDateTime(
  instant: Date,
  locale: LocaleCode,
  timezone: TimezoneId,
): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(instant);
}

export function formatNumber(value: number, locale: LocaleCode, decimals = 0): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/** "7 h 32 min" in the locale's own words. */
export function formatDuration(seconds: number, locale: LocaleCode): string {
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const hourPart =
    hours > 0
      ? new Intl.NumberFormat(locale, { style: 'unit', unit: 'hour', unitDisplay: 'short' }).format(
          hours,
        )
      : null;
  const minutePart = new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'minute',
    unitDisplay: 'short',
  }).format(minutes);

  return hourPart ? `${hourPart} ${minutePart}` : minutePart;
}

/**
 * Distance in the organization's measurement system.
 * Metric organizations see kilometres; imperial ones see miles — the stored value stays metres.
 */
export function formatDistance(
  meters: number,
  locale: LocaleCode,
  system: MeasurementSystem = 'METRIC',
): string {
  if (system === 'IMPERIAL') {
    const miles = meters / 1609.344;
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'mile',
      unitDisplay: 'short',
      maximumFractionDigits: 1,
    }).format(miles);
  }
  const km = meters / 1000;
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'kilometer',
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(km);
}

export function formatConsumption(
  litersPer100Km: number,
  locale: LocaleCode,
  system: MeasurementSystem = 'METRIC',
): string {
  if (system === 'IMPERIAL') {
    const mpg = 235.214583 / litersPer100Km;
    return `${formatNumber(mpg, locale, 1)} mpg`;
  }
  return `${formatNumber(litersPer100Km, locale, 1)} L/100 km`;
}

export function formatPercent(fraction: number, locale: LocaleCode, decimals = 0): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(fraction);
}
