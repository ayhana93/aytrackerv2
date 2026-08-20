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

export type CreateWorkAreaInput = z.infer<typeof createWorkAreaSchema>;
export type UpdateWorkAreaInput = z.infer<typeof updateWorkAreaSchema>;
export type CreatePositionInput = z.infer<typeof createPositionSchema>;
export type UpdatePositionInput = z.infer<typeof updatePositionSchema>;
