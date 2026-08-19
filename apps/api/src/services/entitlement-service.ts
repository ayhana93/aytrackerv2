import { Entitlements, isInRollout, type EntitlementSnapshot } from '@aytracker/billing';
import type { PrismaClient } from '@aytracker/database';
import type { OrganizationId } from '@aytracker/types';

/**
 * Resolves an organization's entitlements.
 *
 * Cached in-process for a short window because it is read on nearly every request and changes
 * rarely (a plan change or a manual grant). The TTL is short enough that an upgrade takes
 * effect within a minute without anyone clearing a cache, and `invalidate` makes it immediate
 * for the request that caused the change.
 */
export class EntitlementService {
  private readonly cache = new Map<string, { snapshot: EntitlementSnapshot; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ttlMs = 60_000,
  ) {}

  async forOrganization(organizationId: OrganizationId): Promise<Entitlements> {
    const now = Date.now();
    const cached = this.cache.get(organizationId);
    if (cached && cached.expiresAt > now) {
      return new Entitlements(cached.snapshot, new Date(now));
    }

    const [rows, organization] = await Promise.all([
      this.prisma.organizationEntitlement.findMany({
        where: { organizationId },
        select: {
          isEnabled: true,
          limit: true,
          expiresAt: true,
          feature: { select: { code: true } },
        },
      }),
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { market: { select: { blockedFeatures: true } } },
      }),
    ]);

    const snapshot: EntitlementSnapshot = {
      organizationId,
      entitlements: rows.map((row) => ({
        featureCode: row.feature.code,
        isEnabled: row.isEnabled,
        limit: row.limit,
        expiresAt: row.expiresAt,
      })),
      marketBlockedFeatures: organization?.market?.blockedFeatures ?? [],
      resolvedAt: new Date(now),
    };

    this.cache.set(organizationId, { snapshot, expiresAt: now + this.ttlMs });
    return new Entitlements(snapshot, new Date(now));
  }

  invalidate(organizationId: OrganizationId): void {
    this.cache.delete(organizationId);
  }

  /**
   * Feature flags — the operational switch, distinct from entitlements.
   *
   * A flag answers "is this code path on for this organization"; an entitlement answers "has
   * this customer paid for it". Both must be true for a gated feature to run, and conflating
   * them makes a kill switch impossible to use during an incident.
   */
  async isFlagEnabled(key: string, organizationId: OrganizationId): Promise<boolean> {
    const flag = await this.prisma.featureFlag.findUnique({ where: { key } });
    if (!flag) return false;
    if (flag.disabledOrgIds.includes(organizationId)) return false;
    if (flag.enabledOrgIds.includes(organizationId)) return true;
    if (!flag.isEnabled) return false;
    return isInRollout(key, organizationId, flag.rolloutPercent);
  }
}
