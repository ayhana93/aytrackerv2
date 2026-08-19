# 1. Fastify over NestJS

**Status:** Accepted

## Context

The brief allowed either and said to prefer Fastify if it keeps the architecture simpler.

NestJS brings dependency injection, decorators, modules and a large convention set. It is a
reasonable choice for a large team that wants those conventions imposed.

## Decision

Fastify, with a hand-written composition root.

## Rationale

The modular architecture is already enforced structurally — by package boundaries, repository
ports, and ESLint import rules. NestJS's module system would be a second, parallel notion of
"module" with different boundaries, which is more confusing than helpful.

The dependency graph is small enough that explicit construction in one file is clearer than a DI
container. `container.ts` can be read top to bottom, and it shows exactly which ports each module
was given — that visibility is worth more here than automatic wiring.

Fastify's plugin model maps directly onto the request pipeline we want (context → errors → auth →
authorization), and its performance headroom matters on the GPS ingestion path.

## Consequences

- Wiring is manual. A new module means editing `container.ts` — visible, and intentionally so.
- No decorator-based validation; Zod schemas are called explicitly at the route. More typing,
  and the same schemas are reused by the web app.
- Fewer conventions means more discipline is required. The ESLint architectural rules exist
  because of this.
