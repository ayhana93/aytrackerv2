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
