/**
 * @aytracker/auth — identity, permissions and session primitives.
 *
 * Pure logic only: no database, no HTTP. The API app wires these into Fastify plugins; the
 * database package uses the role definitions when seeding.
 */

export * from './permissions.js';
export * from './roles.js';
export * from './hashing.js';
export * from './session.js';
export * from './authorization.js';
export * from './lockout.js';
