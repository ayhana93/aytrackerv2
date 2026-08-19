import { ValidationError, money, multiplyMoney } from '@aytracker/domain';
import type { CurrencyCode, Money } from '@aytracker/types';

/**
 * FuelCostCalculator — the one place fuel arithmetic happens.
 *
 * The distinction this file exists to protect: an **estimate** is derived from distance and an
 * average consumption figure; an **actual expense** is what a receipt says. They are different
 * numbers with different trust levels, they are stored separately, and an estimate must never
 * overwrite an actual.
 */

export type ConsumptionUnit =
  /** Litres per 100 km — the European convention. */
  | 'L_PER_100KM'
  /** Miles per US gallon. */
  | 'MPG_US'
  /** Miles per imperial gallon. */
  | 'MPG_UK'
  /** kWh per 100 km, for electric vehicles. */
  | 'KWH_PER_100KM';

const KM_PER_MILE = 1.609344;
const LITERS_PER_US_GALLON = 3.785411784;
const LITERS_PER_UK_GALLON = 4.54609;

/** Normalizes any supported consumption figure to litres (or kWh) per 100 km. */
export function toLitersPer100Km(value: number, unit: ConsumptionUnit): number {
  if (value <= 0) {
    throw new ValidationError('fuel.invalid_consumption', 'Consumption must be positive.');
  }
  switch (unit) {
    case 'L_PER_100KM':
    case 'KWH_PER_100KM':
      return value;
    case 'MPG_US':
      return (100 * LITERS_PER_US_GALLON) / (value * KM_PER_MILE);
    case 'MPG_UK':
      return (100 * LITERS_PER_UK_GALLON) / (value * KM_PER_MILE);
  }
}

export interface FuelEstimateInput {
  readonly distanceMeters: number;
  readonly averageConsumption: number;
  readonly consumptionUnit: ConsumptionUnit;
  /** Price per litre (or per kWh for electric). */
  readonly pricePerLiter: string;
  readonly currency: CurrencyCode;
}

export interface FuelEstimate {
  readonly distanceKm: number;
  readonly liters: number;
  readonly cost: Money;
  /** Always true — the flag exists so the value can never be mistaken for a real expense. */
  readonly isEstimate: true;
}

/**
 * Estimated fuel for a distance.
 *
 * Worked example from the spec:
 *   240 km at 8 L/100 km = 19.2 L; at €1.50/L = €28.80.
 */
export function estimateFuel(input: FuelEstimateInput): FuelEstimate {
  if (input.distanceMeters < 0) {
    throw new ValidationError('fuel.negative_distance', 'Distance must not be negative.');
  }
  const distanceKm = input.distanceMeters / 1000;
  const per100 = toLitersPer100Km(input.averageConsumption, input.consumptionUnit);
  const liters = (distanceKm * per100) / 100;

  const unitPrice = money(input.pricePerLiter, input.currency);
  const cost = multiplyMoney(unitPrice, liters.toFixed(6));

  return {
    distanceKm: round(distanceKm, 3),
    liters: round(liters, 3),
    cost,
    isEstimate: true,
  };
}

export interface FuelExpenseInput {
  readonly liters: string;
  readonly pricePerLiter: string;
  readonly currency: CurrencyCode;
}

/**
 * The authoritative total for a fuel purchase.
 *
 * A client-supplied total is never trusted — it is recomputed here from litres and unit price,
 * which are the two numbers actually printed on the receipt.
 */
export function calculateFuelTotal(input: FuelExpenseInput): Money {
  const liters = Number(input.liters);
  if (!Number.isFinite(liters) || liters <= 0) {
    throw new ValidationError('fuel.invalid_liters', 'Litres must be a positive number.');
  }
  const unitPrice = money(input.pricePerLiter, input.currency);
  return multiplyMoney(unitPrice, input.liters);
}

export interface ConsumptionFromRefuelsInput {
  /** Odometer at the previous full-tank refuel. */
  readonly previousOdometer: number;
  /** Odometer at this full-tank refuel. */
  readonly currentOdometer: number;
  /** Litres put in at this refuel. */
  readonly liters: number;
}

/**
 * Real consumption between two full-tank refuels — the "brim to brim" method.
 *
 * Only valid when both refuels filled the tank; partial fills make the arithmetic meaningless,
 * which is why FuelExpense carries `isFullTank`.
 */
export function consumptionFromRefuels(input: ConsumptionFromRefuelsInput): number {
  const distanceKm = input.currentOdometer - input.previousOdometer;
  if (distanceKm <= 0) {
    throw new ValidationError(
      'fuel.invalid_odometer_span',
      'Current odometer must exceed the previous reading.',
    );
  }
  if (input.liters <= 0) {
    throw new ValidationError('fuel.invalid_liters', 'Litres must be positive.');
  }
  return round((input.liters / distanceKm) * 100, 3);
}

export interface CostPerKmInput {
  readonly totalCost: Money;
  readonly distanceMeters: number;
}

/** Cost per kilometre. Returns null for zero distance rather than dividing by zero. */
export function costPerKm(input: CostPerKmInput): Money | null {
  if (input.distanceMeters <= 0) return null;
  const km = input.distanceMeters / 1000;
  return multiplyMoney(input.totalCost, (1 / km).toFixed(9));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
