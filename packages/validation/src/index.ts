/**
 * @aytracker/validation — Zod schemas for every request the API accepts.
 *
 * Shared with the web app so a form and its endpoint cannot drift apart. Validation is the
 * outermost check only: passing a schema never implies authorization, tenancy or entitlement.
 */

export * from './primitives.js';
export * from './auth.js';
export * from './workforce.js';
export * from './shifts.js';
export * from './drivers.js';
export * from './fleet.js';
export * from './platform.js';
