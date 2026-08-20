import { z } from 'zod';
import { codeSchema, emailSchema } from './primitives.js';

/**
 * Authentication request schemas.
 *
 * Note what is absent from every one of these: `organizationId`, `role`, `permissions`,
 * `workerId`. Those are server-determined. A worker login carries an organization *slug*
 * because the login form has to be scoped somehow, and the server resolves it to a tenant — a
 * slug is a lookup key, never an authorization claim.
 */

export const adminLoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
});

export const workerLoginSchema = z.object({
  organizationSlug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Invalid organization identifier'),
  employeeNumber: codeSchema,
  pin: z.string().regex(/^\d{4,8}$/, 'PIN must be 4–8 digits'),
});

export const driverLoginSchema = z.object({
  organizationSlug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Invalid organization identifier'),
  driverCode: codeSchema,
  pin: z.string().regex(/^\d{4,8}$/, 'PIN must be 4–8 digits'),
});

/**
 * Self-serve signup.
 *
 * Note what is *not* here, again: no slug, no plan, no role. The slug is derived server-side from
 * the company name (a caller who picked their own could squat on another company's), the plan is
 * a trial the server decides, and the first user is an owner because they created the tenant —
 * not because they asked to be.
 *
 * The password floor is twelve characters, matching `changePasswordSchema`. Length rather than a
 * character-class rule: a composition requirement mostly teaches people to write `Password1!`,
 * while length is the property that actually costs an attacker something.
 */
export const registerSchema = z.object({
  companyName: z.string().trim().min(2).max(120),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: emailSchema,
  password: z.string().min(12, 'Паролата трябва да е поне 12 знака').max(256),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(12).max(256),
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: 'The new password must differ from the current one',
    path: ['newPassword'],
  });

export const setPinSchema = z.object({
  pin: z.string().regex(/^\d{4,8}$/, 'PIN must be 4–8 digits'),
});

export type AdminLoginInput = z.infer<typeof adminLoginSchema>;
export type WorkerLoginInput = z.infer<typeof workerLoginSchema>;
export type DriverLoginInput = z.infer<typeof driverLoginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
