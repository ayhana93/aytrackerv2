import type { CurrencyCode, Money } from '@aytracker/types';
import { ValidationError } from './errors.js';

/**
 * Money arithmetic in minor units (integer cents), because binary floating point cannot
 * represent 0.1 and invoices are not the place to find that out.
 *
 * The public shape stays `{ amount: string, currency }` so nothing downstream is tempted to do
 * arithmetic on a JS number.
 */

/** Currencies whose minor unit is not 1/100. Extend as markets are added. */
const EXPONENT_OVERRIDES: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  ISK: 0,
  CLP: 0,
  BHD: 3,
  KWD: 3,
  TND: 3,
};

export function minorUnitExponent(currency: CurrencyCode): number {
  return EXPONENT_OVERRIDES[currency.toUpperCase()] ?? 2;
}

export function assertCurrency(currency: string): asserts currency is CurrencyCode {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ValidationError('money.invalid_currency', `Invalid currency code: ${currency}`);
  }
}

/** Parses a decimal string into integer minor units. Rejects anything it cannot represent. */
export function toMinorUnits(amount: string, currency: CurrencyCode): bigint {
  assertCurrency(currency);
  const exponent = minorUnitExponent(currency);
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) {
    throw new ValidationError('money.invalid_amount', `Invalid money amount: ${amount}`);
  }
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > exponent) {
    throw new ValidationError(
      'money.excess_precision',
      `${currency} supports ${exponent} decimal places, got ${fraction.length}.`,
    );
  }
  const padded = fraction.padEnd(exponent, '0');
  const value = BigInt(`${whole}${padded}`);
  return sign === '-' ? -value : value;
}

export function fromMinorUnits(minor: bigint, currency: CurrencyCode): Money {
  assertCurrency(currency);
  const exponent = minorUnitExponent(currency);
  const negative = minor < 0n;
  const absolute = (negative ? -minor : minor).toString().padStart(exponent + 1, '0');
  const whole = absolute.slice(0, absolute.length - exponent);
  const fraction = exponent === 0 ? '' : `.${absolute.slice(absolute.length - exponent)}`;
  return { amount: `${negative ? '-' : ''}${whole}${fraction}`, currency };
}

export function money(amount: string | number, currency: CurrencyCode): Money {
  const asString =
    typeof amount === 'number' ? amount.toFixed(minorUnitExponent(currency)) : amount;
  // Round-trip through minor units so the stored string is always canonical.
  return fromMinorUnits(toMinorUnits(asString, currency), currency);
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new ValidationError(
      'money.currency_mismatch',
      `Cannot combine ${a.currency} with ${b.currency}.`,
    );
  }
}

export function addMoney(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return fromMinorUnits(
    toMinorUnits(a.amount, a.currency) + toMinorUnits(b.amount, b.currency),
    a.currency,
  );
}

export function subtractMoney(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return fromMinorUnits(
    toMinorUnits(a.amount, a.currency) - toMinorUnits(b.amount, b.currency),
    a.currency,
  );
}

export function sumMoney(values: readonly Money[], currency: CurrencyCode): Money {
  return values.reduce<Money>((acc, value) => addMoney(acc, value), money('0', currency));
}

/**
 * Multiplies money by a decimal quantity with banker's-rounding-free half-up rounding at the
 * currency's minor unit. Used for `liters × pricePerLiter` and tax.
 */
export function multiplyMoney(value: Money, factor: string | number): Money {
  const factorString = typeof factor === 'number' ? String(factor) : factor.trim();
  const factorMatch = /^(-)?(\d+)(?:\.(\d+))?$/.exec(factorString);
  if (!factorMatch) {
    throw new ValidationError('money.invalid_factor', `Invalid multiplier: ${factorString}`);
  }
  const [, sign, whole, fraction = ''] = factorMatch;
  const factorScale = fraction.length;
  const factorInt = BigInt(`${whole}${fraction}`) * (sign === '-' ? -1n : 1n);

  const minor = toMinorUnits(value.amount, value.currency);
  const scaled = minor * factorInt;
  const divisor = 10n ** BigInt(factorScale);
  const rounded = divideHalfUp(scaled, divisor);
  return fromMinorUnits(rounded, value.currency);
}

/** Integer division rounding halves away from zero — the convention invoices expect. */
export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new ValidationError('money.division_by_zero', 'Division by zero.');
  }
  const negative = numerator < 0n !== denominator < 0n;
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const quotient = a / b;
  const remainder = a % b;
  const rounded = remainder * 2n >= b ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

export function compareMoney(a: Money, b: Money): number {
  sameCurrency(a, b);
  const left = toMinorUnits(a.amount, a.currency);
  const right = toMinorUnits(b.amount, b.currency);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isZeroMoney(value: Money): boolean {
  return toMinorUnits(value.amount, value.currency) === 0n;
}
