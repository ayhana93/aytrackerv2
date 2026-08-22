import type { FastifyPluginAsync } from 'fastify';
import { NotFoundError } from '@aytracker/domain';
import { displayName, logoAssetUrl } from '../lib/branding.js';
import type { AppServices } from '../services/container.js';

/**
 * /api/v1/branding — the only unauthenticated part of the tenant surface.
 *
 * It exists because branding has to render before anybody is signed in. A worker standing at the
 * login screen has not proved who they are yet, and that screen is exactly where their own
 * company's name and logo have to appear — if branding required a session, every customer's front
 * door would carry the product's name instead of theirs.
 *
 * What that costs, stated plainly: anyone who knows or guesses a tenant slug can read that
 * tenant's company name and logo. Both are already on the login page the slug opens, so this
 * publishes nothing the slug did not already publish. Nothing else is served here — no member,
 * no setting, no count.
 */
export function brandingRoutes(services: AppServices): FastifyPluginAsync {
  return async (app) => {
    /**
     * The logo bytes.
     *
     * Immutable by construction: the id addresses one specific upload, and choosing a different
     * logo produces a different id rather than changing what this one returns. That is what makes
     * a year-long cache honest — a customer who swaps their logo is not waiting on somebody
     * else's cache to expire, because their login page now points at another URL.
     */
    app.get(
      '/logos/:logoId',
      // Cheaper than the global limit allows for, and served to unauthenticated callers keyed by
      // IP: a login page loads one of these, a script pulling them in a loop is doing something
      // else.
      { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const { logoId } = request.params as { logoId: string };

        const logo = await services.prisma.organizationLogo.findUnique({
          where: { id: logoId },
          select: { contentType: true, data: true, checksum: true },
        });
        if (!logo) throw new NotFoundError('branding.logo_not_found', 'No such logo.');

        const etag = `"${logo.checksum}"`;
        if (request.headers['if-none-match'] === etag) {
          return reply.status(304).header('etag', etag).send();
        }

        return (
          reply
            .header('content-type', logo.contentType)
            // The type was sniffed from the bytes on upload, so it is accurate — and `nosniff`
            // keeps a browser from deciding otherwise about a file crafted to be two things.
            .header('x-content-type-options', 'nosniff')
            .header('cache-control', 'public, max-age=31536000, immutable')
            .header('etag', etag)
            .send(Buffer.from(logo.data))
        );
      },
    );

    /**
     * A tenant's public identity, by the code its staff type in.
     *
     * The login screens ask for this the moment a company code is present, so a worker sees their
     * own company on the door rather than the product's name.
     */
    app.get(
      '/public',
      { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
      async (request) => {
        const slug = String((request.query as { slug?: string }).slug ?? '')
          .trim()
          .toLowerCase();
        if (slug === '') throw new NotFoundError('branding.unknown_organization', 'No such code.');

        const organization = await services.prisma.organization.findFirst({
          where: { slug, deletedAt: null },
          select: {
            name: true,
            slug: true,
            branding: {
              select: {
                companyName: true,
                logoAssetId: true,
                primaryColor: true,
                loginMessage: true,
              },
            },
          },
        });

        /**
         * One error for "no such organization", and no timing games beyond that. A company code
         * is a lookup key, not a secret — it is printed on the notice by the door — so this
         * confirms nothing that walking up to the tablet would not.
         */
        if (!organization) {
          throw new NotFoundError('branding.unknown_organization', 'No such code.');
        }

        return {
          organizationSlug: organization.slug,
          organizationName: displayName(organization, organization.branding),
          logoUrl: organization.branding?.logoAssetId
            ? logoAssetUrl(services.config.env.API_URL, organization.branding.logoAssetId)
            : null,
          primaryColor: organization.branding?.primaryColor ?? null,
          loginMessage: organization.branding?.loginMessage ?? null,
        };
      },
    );
  };
}
