import { ValidationError, addMoney, money, sumMoney } from '@aytracker/domain';
import type { CurrencyCode, Money, VehicleId } from '@aytracker/types';
import { costPerKm, estimateFuel, type ConsumptionUnit } from '@aytracker/tracking';

/**
 * Vehicle cost roll-ups.
 *
 * All fleet arithmetic lives here so "cost per km" means the same number on the vehicle page,
 * the monthly report and the fleet dashboard.
 */

export type ExpenseCategory =
  | 'FUEL'
  | 'INSURANCE'
  | 'VIGNETTE'
  | 'ROAD_TOLL'
  | 'MAINTENANCE'
  | 'REPAIR'
  | 'TAX'
  | 'INSPECTION'
  | 'PARKING'
  | 'LEASING'
  | 'FINE'
  | 'OTHER';

export interface ExpenseLine {
  readonly category: ExpenseCategory;
  readonly amount: Money;
  readonly date: Date;
}

export interface VehicleCostBreakdown {
  readonly vehicleId: VehicleId;
  readonly currency: CurrencyCode;
  readonly byCategory: Readonly<Record<ExpenseCategory, Money>>;
  readonly total: Money;
  readonly distanceMeters: number;
  /** Null when the vehicle covered no distance in the period — not zero, which would lie. */
  readonly costPerKm: Money | null;
  readonly fuelCostPerKm: Money | null;
}

const ALL_CATEGORIES: readonly ExpenseCategory[] = [
  'FUEL',
  'INSURANCE',
  'VIGNETTE',
  'ROAD_TOLL',
  'MAINTENANCE',
  'REPAIR',
  'TAX',
  'INSPECTION',
  'PARKING',
  'LEASING',
  'FINE',
  'OTHER',
];

/**
 * Totals a vehicle's costs for a period.
 *
 * Mixed currencies are rejected rather than silently converted: a fleet operating across a
 * currency border needs an explicit FX decision with a rate date, not an invented number.
 * Fuel rows recorded through `FuelExpense` arrive here already linked to their `VehicleExpense`
 * row, so fuel is counted exactly once.
 */
export function summarizeVehicleCosts(input: {
  vehicleId: VehicleId;
  currency: CurrencyCode;
  lines: readonly ExpenseLine[];
  distanceMeters: number;
}): VehicleCostBreakdown {
  const mismatched = input.lines.find((line) => line.amount.currency !== input.currency);
  if (mismatched) {
    throw new ValidationError(
      'fleet.mixed_currency',
      `Cannot total ${mismatched.amount.currency} alongside ${input.currency}.`,
      { details: { expected: input.currency, found: mismatched.amount.currency } },
    );
  }

  const byCategory = Object.fromEntries(
    ALL_CATEGORIES.map((category) => [
      category,
      sumMoney(
        input.lines.filter((line) => line.category === category).map((line) => line.amount),
        input.currency,
      ),
    ]),
  ) as Record<ExpenseCategory, Money>;

  const total = input.lines.reduce<Money>(
    (acc, line) => addMoney(acc, line.amount),
    money('0', input.currency),
  );

  return {
    vehicleId: input.vehicleId,
    currency: input.currency,
    byCategory,
    total,
    distanceMeters: input.distanceMeters,
    costPerKm: costPerKm({ totalCost: total, distanceMeters: input.distanceMeters }),
    fuelCostPerKm: costPerKm({
      totalCost: byCategory.FUEL,
      distanceMeters: input.distanceMeters,
    }),
  };
}

export interface FuelComparison {
  readonly estimated: Money;
  readonly actual: Money;
  /** actual − estimated. Positive means the vehicle used more than its average predicts. */
  readonly variance: Money;
  readonly variancePercent: number | null;
}

/**
 * Compares estimated fuel cost against what was actually spent.
 *
 * Both numbers are kept; neither overwrites the other. A persistent positive variance is a
 * maintenance signal (or a stale average-consumption figure), which is exactly why the estimate
 * must survive alongside the receipt rather than being replaced by it.
 */
export function compareFuel(input: {
  distanceMeters: number;
  averageConsumption: number;
  consumptionUnit: ConsumptionUnit;
  pricePerLiter: string;
  currency: CurrencyCode;
  actualFuelCost: Money;
}): FuelComparison {
  const estimate = estimateFuel({
    distanceMeters: input.distanceMeters,
    averageConsumption: input.averageConsumption,
    consumptionUnit: input.consumptionUnit,
    pricePerLiter: input.pricePerLiter,
    currency: input.currency,
  });

  const estimatedValue = Number(estimate.cost.amount);
  const actualValue = Number(input.actualFuelCost.amount);
  const variance = money((actualValue - estimatedValue).toFixed(2), input.currency);

  return {
    estimated: estimate.cost,
    actual: input.actualFuelCost,
    variance,
    variancePercent:
      estimatedValue > 0
        ? Math.round(((actualValue - estimatedValue) / estimatedValue) * 100)
        : null,
  };
}
