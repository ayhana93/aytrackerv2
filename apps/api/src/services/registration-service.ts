import { hashPassword } from '@aytracker/auth';
import type { PrismaClient } from '@aytracker/database';
import { ConflictError } from '@aytracker/domain';
import { slugify } from '../lib/slug.js';

/**
 * Self-serve tenant creation.
 *
 * One transaction, because a half-created tenant is worse than none: an organization with no
 * owner cannot be signed into and cannot be deleted through the product, so it sits in the
 * database forever holding a slug someone else wanted.
 *
 * What a new organization gets, and why each one is here rather than "later, in settings":
 *
 *   * **An owner.** The person who created the tenant. Not a role they asked for — a role the
 *     server assigns because somebody has to be able to add the second user.
 *   * **A site.** Every work area and position hangs off one, so an organization without a site
 *     cannot create anything at all and the first screen after signup would be a dead end.
 *   * **A default work area.** So "add a position" works immediately. An empty state that
 *     requires two levels of setup before anything can be entered is where people give up.
 *   * **A trial entitlement set.** Otherwise GPS tracking is dark on day one and the product
 *     looks broken rather than unpaid.
 */

/** Long enough to evaluate the product, short enough to be a trial. */
const TRIAL_DAYS = 30;

/** The plan a trial is modelled on. Trials get the full feature set; the limit is time. */
const TRIAL_PLAN_CODE = 'business';

export interface RegistrationResult {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly userId: string;
  readonly permissions: readonly string[];
}

export class RegistrationService {
  constructor(private readonly prisma: PrismaClient) {}

  async register(input: {
    companyName: string;
    firstName: string;
    lastName: string;
    email: string;
    password: string;
    now: Date;
  }): Promise<RegistrationResult> {
    /**
     * Hashed before the transaction opens, never inside it.
     *
     * Argon2id is deliberately slow — that is the entire point of it. Running it inside the
     * transaction would hold a write transaction open for the duration of a KDF, and under any
     * real signup rate that is how a connection pool gets exhausted by people typing.
     */
    const passwordHash = await hashPassword(input.password);

    const existing = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictError('auth.email_taken', 'That email address is already registered.');
    }

    const [ownerRole, plan, market] = await Promise.all([
      this.prisma.role.findFirst({
        where: { organizationId: null, code: 'owner' },
        select: { id: true, permissions: true },
      }),
      this.prisma.plan.findUnique({
        where: { code: TRIAL_PLAN_CODE },
        select: { id: true, planFeatures: { select: { featureId: true } } },
      }),
      this.prisma.market.findUnique({ where: { code: 'BG' }, select: { id: true } }),
    ]);

    if (!ownerRole) {
      // Platform reference data is missing, which is an operator problem, not a caller problem.
      // Failing loudly beats creating an organization nobody can administer.
      throw new Error(
        'System roles are not seeded. Run the platform seed before accepting signups.',
      );
    }

    const slug = await this.availableSlug(input.companyName);
    const trialEndsAt = new Date(input.now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          slug,
          name: input.companyName,
          status: 'TRIAL',
          countryCode: 'BG',
          billingCountry: 'BG',
          marketId: market?.id ?? null,
          defaultLocale: 'bg',
          defaultTimezone: 'Europe/Sofia',
          defaultCurrency: 'EUR',
          trialEndsAt,
          settings: { create: {} },
        },
        select: { id: true, slug: true },
      });

      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
          preferredLocale: 'bg',
          /**
           * Marked verified because nothing verifies it yet.
           *
           * There is no mail transport in this deployment, so leaving it null would lock every
           * new account out of a product they just created. This is a real gap, not a decision:
           * when email sending exists, this becomes null and a verification link is sent. Until
           * then the honest description is that signup trusts the address it was given.
           */
          emailVerifiedAt: input.now,
          memberships: {
            create: {
              organizationId: organization.id,
              roleId: ownerRole.id,
              status: 'ACTIVE',
              joinedAt: input.now,
            },
          },
        },
        select: { id: true },
      });

      if (plan && plan.planFeatures.length > 0) {
        await tx.organizationEntitlement.createMany({
          data: plan.planFeatures.map((feature) => ({
            organizationId: organization.id,
            featureId: feature.featureId,
            isEnabled: true,
            source: 'TRIAL' as const,
            expiresAt: trialEndsAt,
          })),
          skipDuplicates: true,
        });
      }

      const site = await tx.site.create({
        data: {
          organizationId: organization.id,
          name: input.companyName,
          code: 'MAIN',
          timezone: 'Europe/Sofia',
          countryCode: 'BG',
        },
        select: { id: true },
      });

      await tx.workArea.create({
        data: {
          organizationId: organization.id,
          siteId: site.id,
          name: 'Основна зона',
          code: 'MAIN',
        },
      });

      return {
        organizationId: organization.id,
        organizationSlug: organization.slug,
        userId: user.id,
        permissions: ownerRole.permissions,
      };
    });
  }

  /**
   * A free slug derived from the company name.
   *
   * Checked-then-inserted, so two simultaneous signups of the same company name can still race.
   * The unique index on `slug` is what actually decides; this loop only keeps the common case
   * from hitting it. A caller who loses that race gets a 409 and retries, which is the correct
   * outcome for a name someone else just took.
   */
  private async availableSlug(companyName: string): Promise<string> {
    const base = slugify(companyName) || 'org';

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const taken = await this.prisma.organization.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
    }

    // Fifty collisions on one name means the name is not the distinguishing part any more.
    return `${base}-${Date.now().toString(36)}`;
  }
}
