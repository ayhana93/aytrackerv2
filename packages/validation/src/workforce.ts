import { z } from 'zod';
import { codeSchema, textSchema, uuidSchema } from './primitives.js';

/**
 * Work areas and the positions inside them.
 *
 * A work area is the wing, zone or department a position belongs to — the extrusion hall, the
 * paint shop, the third floor, transport. Positions hang off one, and every report that groups
 * work by anything other than a person groups it by this.
 *
 * `code` is optional on the way in and derived from the name when it is missing. Asking someone
 * to invent a short unique key before they can name a room is a setup step that buys the product
 * nothing and loses the person filling in the form.
 */

export const createWorkAreaSchema = z.object({
  name: textSchema(2, 80),
  code: codeSchema.optional(),
  description: textSchema(1, 300).optional(),
});

export const updateWorkAreaSchema = z.object({
  name: textSchema(2, 80).optional(),
  description: textSchema(1, 300).nullable().optional(),
  /**
   * Archiving, not deleting.
   *
   * A work area is referenced by every position session ever recorded against its positions, so
   * removing one would either orphan history or cascade it away. Both are worse than a row that
   * stops appearing in pickers.
   */
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});

/**
 * DRIVING is not a label — it changes what occupying the position does.
 *
 * Taking a DRIVING position opens a vehicle assignment and a trip alongside the position session,
 * and leaving it closes both. See docs/driving-handoff.md.
 */
export const positionKindSchema = z.enum(['STANDARD', 'DRIVING']);

export const createPositionSchema = z.object({
  workAreaId: uuidSchema,
  name: textSchema(2, 80),
  code: codeSchema.optional(),
  kind: positionKindSchema.default('STANDARD'),
  /** Concurrent workers allowed. Null or absent means no cap. */
  capacity: z.coerce.number().int().min(1).max(999).nullable().optional(),
});

export const updatePositionSchema = z.object({
  name: textSchema(2, 80).optional(),
  workAreaId: uuidSchema.optional(),
  kind: positionKindSchema.optional(),
  capacity: z.coerce.number().int().min(1).max(999).nullable().optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});

/**
 * The people who clock in.
 *
 * `employeeNumber` is the identifier a worker types on their own login screen, unique inside the
 * organization and chosen by whoever runs the place — it is almost always a number they already
 * use on a rota or a payslip, so the server does not invent one.
 *
 * The PIN is optional on creation and that is deliberate rather than lax: an admin setting up
 * twenty people on a Friday afternoon should be able to enter the roster first and hand out PINs
 * as each person arrives. A worker without a PIN simply cannot sign in yet, which is a true and
 * visible state, not a broken one.
 */
/**
 * Rejects 0000, 1111, 1234, 4321 and friends — the PINs an attacker tries first.
 *
 * Duplicated in shape, not in authority: `assertPinPolicy` in `@aytracker/auth` is what actually
 * guards the hash, and it runs whatever this schema does. The rule is repeated here so a caller
 * is refused at the edge with a message naming the field, rather than three layers in with a code
 * the form has to translate — and so an admin choosing a PIN for somebody else learns the rule
 * while typing instead of after submitting.
 */
export function isTriviallyGuessablePin(pin: string): boolean {
  if (/^(\d)\1*$/.test(pin)) return true;
  const digits = [...pin].map(Number);
  const ascending = digits.every(
    (digit, index) => index === 0 || digit === (digits[index - 1] ?? 0) + 1,
  );
  const descending = digits.every(
    (digit, index) => index === 0 || digit === (digits[index - 1] ?? 0) - 1,
  );
  return ascending || descending;
}

export const pinSchema = z
  .string()
  .regex(/^\d{4,8}$/, 'ПИН-ът е между 4 и 8 цифри')
  .refine((pin) => !isTriviallyGuessablePin(pin), {
    message: 'ПИН-ът не може да е еднакви цифри или поредица като 1234',
  });

export const createWorkerSchema = z.object({
  employeeNumber: codeSchema,
  firstName: textSchema(1, 80),
  lastName: textSchema(1, 80),
  email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  pin: pinSchema.optional(),
  /**
   * Also give this person a driver profile.
   *
   * A driver is a separate row because driving carries its own credential, its own licence and
   * its own portal — but most drivers in a small operation are workers who also drive, so making
   * this a checkbox on the worker form rather than a second screen matches how the job is
   * actually done. The driver code defaults to the employee number, and the PIN is shared.
   */
  isDriver: z.boolean().default(false),
  driverCode: codeSchema.optional(),
});

export const updateWorkerSchema = z.object({
  firstName: textSchema(1, 80).optional(),
  lastName: textSchema(1, 80).optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  /** A new PIN. Setting one also clears any lockout — that is the point of resetting it. */
  pin: pinSchema.optional(),
  /**
   * Deactivating, not deleting.
   *
   * A worker is referenced by every session, shift and production entry they ever recorded, so
   * removing one would either orphan the history or cascade it away — and that history is what
   * payslips are checked against. `INACTIVE` and `ON_LEAVE` both exist on the model; only the
   * two ends are offered here, because "on leave" is a rota decision this screen does not make
   * and `TERMINATED` is a personnel record nobody should be able to set with one click.
   */
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

export type CreateWorkerInput = z.infer<typeof createWorkerSchema>;
export type UpdateWorkerInput = z.infer<typeof updateWorkerSchema>;
export type CreateWorkAreaInput = z.infer<typeof createWorkAreaSchema>;
export type UpdateWorkAreaInput = z.infer<typeof updateWorkAreaSchema>;
export type CreatePositionInput = z.infer<typeof createPositionSchema>;
export type UpdatePositionInput = z.infer<typeof updatePositionSchema>;
