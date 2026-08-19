/**
 * @aytracker/database — Prisma client, tenant scoping and error translation.
 *
 * The only package allowed to import `@prisma/client`. Modules depend on repository *ports*
 * defined in their own `domain/` folder; the Prisma implementations of those ports live in the
 * module's `infrastructure/` folder and import from here.
 */

export * from './client.js';
export * from './errors.js';
