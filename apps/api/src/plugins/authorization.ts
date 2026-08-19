import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { assertActorType, assertPermission, type Permission } from '@aytracker/auth';
import type { Entitlements, FeatureCode } from '@aytracker/billing';
import type { ActorContext } from '@aytracker/types';
import type { EntitlementService } from '../services/entitlement-service.js';

/**
 * Authorization guards.
 *
 * Composed onto routes as preHandlers so the requirement is visible at the route definition
 * rather than buried in a handler. Three independent gates, in order:
 *
 *   requirePermission  — does this actor hold the permission?
 *   requireActorType   — is this the right kind of session? (a worker token must not reach an
 *                        admin endpoint even if permissions somehow overlapped)
 *   requireEntitlement — has this organization paid for the feature?
 *
 * Permission and entitlement are deliberately separate. A user can have `fleet.read` while
 * their organization is on a plan without fleet — the answer is "upgrade", not "forbidden",
 * and conflating the two produces the wrong message and the wrong upsell.
 */

declare module 'fastify' {
  interface FastifyRequest {
    entitlements?: Entitlements;
  }
}

export interface AuthorizationPluginOptions {
  readonly entitlements: EntitlementService;
}

const authorizationPlugin: FastifyPluginAsync<AuthorizationPluginOptions> = async (
  app,
  options,
) => {
  app.decorateRequest('entitlements', undefined);

  app.decorate(
    'requirePermission',
    (permission: Permission) => async (request: FastifyRequest, _reply: FastifyReply) => {
      const actor = app.requireAuth(request);
      assertPermission(actor, permission);
    },
  );

  app.decorate(
    'requireActorType',
    (allowed: readonly ActorContext['actorType'][]) =>
      async (request: FastifyRequest, _reply: FastifyReply) => {
        const actor = app.requireAuth(request);
        assertActorType(actor, allowed);
      },
  );

  app.decorate(
    'requireEntitlement',
    (feature: FeatureCode) => async (request: FastifyRequest, _reply: FastifyReply) => {
      const actor = app.requireAuth(request);
      const entitlements = await options.entitlements.forOrganization(actor.organizationId);
      request.entitlements = entitlements;
      entitlements.require(feature);
    },
  );
};

declare module 'fastify' {
  interface FastifyInstance {
    requirePermission: (
      permission: Permission,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireActorType: (
      allowed: readonly ActorContext['actorType'][],
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireEntitlement: (
      feature: FeatureCode,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(authorizationPlugin, {
  name: 'authorization',
  dependencies: ['authentication'],
});
