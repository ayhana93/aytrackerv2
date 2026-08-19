import { z } from 'zod';
import {
  codeSchema,
  currencyCodeSchema,
  isoDateTimeSchema,
  nonNegativeDecimalStringSchema,
  positiveDecimalStringSchema,
  uuidSchema,
} from './primitives.js';

export const vehicleTypeSchema = z.enum(['CAR', 'VAN', 'TRUCK', 'BUS', 'FORKLIFT', 'OTHER']);
export const fuelTypeSchema = z.enum([
  'PETROL',
  'DIESEL',
  'LPG',
  'CNG',
  'ELECTRIC',
  'HYBRID',
  'OTHER',
]);

export const createVehicleSchema = z.object({
  siteId: uuidSchema.nullable().default(null),
  registrationNumber: codeSchema,
  vin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-HJ-NPR-Z0-9]{17}$/, 'A VIN is 17 characters and excludes I, O and Q')
    .nullable()
    .default(null),
  make: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(64),
  year: z.number().int().min(1900).max(2100).nullable().default(null),
  vehicleType: vehicleTypeSchema,
  fuelType: fuelTypeSchema,
  fuelTankCapacity: positiveDecimalStringSchema.nullable().default(null),
  odometerCurrent: nonNegativeDecimalStringSchema.default('0'),
  averageConsumption: positiveDecimalStringSchema.nullable().default(null),
  consumptionUnit: z
    .enum(['L_PER_100KM', 'MPG_US', 'MPG_UK', 'KWH_PER_100KM'])
    .default('L_PER_100KM'),
  notes: z.string().trim().max(2000).optional(),
});

export const assignVehicleSchema = z.object({
  driverId: uuidSchema,
  vehicleId: uuidSchema,
  startedAt: isoDateTimeSchema.optional(),
  notes: z.string().trim().max(500).optional(),
});

/**
 * A fuel purchase.
 *
 * `totalCost` is deliberately absent: the server computes it as `liters × pricePerLiter`.
 * Accepting a client-supplied total would let a typo — or a deliberate edit — put a number in
 * the cost report that no receipt supports.
 */
export const createFuelExpenseSchema = z.object({
  vehicleId: uuidSchema,
  driverId: uuidSchema.nullable().default(null),
  tripId: uuidSchema.nullable().default(null),
  date: isoDateTimeSchema,
  liters: positiveDecimalStringSchema,
  pricePerLiter: nonNegativeDecimalStringSchema,
  currency: currencyCodeSchema,
  odometer: nonNegativeDecimalStringSchema.nullable().default(null),
  isFullTank: z.boolean().default(true),
  receiptReference: z.string().trim().max(120).nullable().default(null),
  notes: z.string().trim().max(1000).optional(),
});

export const expenseCategorySchema = z.enum([
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
]);

export const createVehicleExpenseSchema = z.object({
  vehicleId: uuidSchema,
  category: expenseCategorySchema,
  amount: positiveDecimalStringSchema,
  currency: currencyCodeSchema,
  date: isoDateTimeSchema,
  odometer: nonNegativeDecimalStringSchema.nullable().default(null),
  vendor: z.string().trim().max(160).nullable().default(null),
  notes: z.string().trim().max(1000).optional(),
});

export const vehicleDocumentSchema = z.object({
  vehicleId: uuidSchema,
  type: z.enum([
    'INSURANCE',
    'TECHNICAL_INSPECTION',
    'VIGNETTE',
    'REGISTRATION',
    'LEASING_CONTRACT',
    'TACHOGRAPH',
    'OTHER',
  ]),
  name: z.string().trim().min(1).max(160),
  reference: z.string().trim().max(120).nullable().default(null),
  issuedAt: isoDateTimeSchema.nullable().default(null),
  expiresAt: isoDateTimeSchema.nullable().default(null),
  reminderDays: z.number().int().min(0).max(365).default(30),
  notes: z.string().trim().max(1000).optional(),
});

export type CreateVehicleRequest = z.infer<typeof createVehicleSchema>;
export type CreateFuelExpenseRequest = z.infer<typeof createFuelExpenseSchema>;
