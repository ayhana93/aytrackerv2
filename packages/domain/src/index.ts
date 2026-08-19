/**
 * @aytracker/domain — shared domain kernel.
 *
 * Contains only what several modules need: errors, results, money, time and the event bus.
 * Module-specific rules live inside that module's `domain/` folder, never here.
 *
 * This package must never import React, Next, Prisma, Fastify, or any module.
 */

export * from './errors.js';
export * from './result.js';
export * from './money.js';
export * from './time.js';
export * from './events.js';
export * from './pagination.js';
