import type { DatabaseClient } from '@aytracker/database';
import type {
  OrganizationId,
  PositionId,
  QualificationId,
  SiteId,
  WorkerId,
} from '@aytracker/types';
import type {
  PositionRule,
  WorkerQualificationHolding,
  EligibilityOverride,
} from '../domain/eligibility.js';
import type {
  EligibilityRepository,
  OrganizationPolicyRepository,
  PositionRepository,
  QualificationRepository,
  WorkerCredentials,
  WorkerRepository,
  WorkerSummary,
} from '../domain/ports.js';

/**
 * Prisma implementations of the workforce ports.
 *
 * This is the only layer in the module that knows a database exists. Note that every `where`
 * clause starts with `organizationId` — not as a convention, but because the composite tenant
 * foreign keys in the schema mean a query that forgets it can return another tenant's row.
 */

export class PrismaWorkerRepository implements WorkerRepository {
  constructor(private readonly db: DatabaseClient) {}

  async findById(
    organizationId: OrganizationId,
    workerId: WorkerId,
  ): Promise<WorkerSummary | null> {
    const worker = await this.db.worker.findFirst({
      where: { id: workerId, organizationId, deletedAt: null },
      select: {
        id: true,
        organizationId: true,
        siteId: true,
        employeeNumber: true,
        firstName: true,
        lastName: true,
        status: true,
        preferredLocale: true,
      },
    });
    return worker ? (worker as WorkerSummary) : null;
  }

  async findByEmployeeNumber(
    organizationId: OrganizationId,
    employeeNumber: string,
  ): Promise<WorkerSummary | null> {
    const worker = await this.db.worker.findFirst({
      where: {
        organizationId,
        employeeNumber: { equals: employeeNumber, mode: 'insensitive' },
        deletedAt: null,
      },
      select: {
        id: true,
        organizationId: true,
        siteId: true,
        employeeNumber: true,
        firstName: true,
        lastName: true,
        status: true,
        preferredLocale: true,
      },
    });
    return worker ? (worker as WorkerSummary) : null;
  }

  /** Deliberately separate from findById so credential material is never loaded by accident. */
  async findCredentials(
    organizationId: OrganizationId,
    workerId: WorkerId,
  ): Promise<WorkerCredentials | null> {
    const worker = await this.db.worker.findFirst({
      where: { id: workerId, organizationId, deletedAt: null },
      select: {
        id: true,
        organizationId: true,
        pinHash: true,
        failedPinAttempts: true,
        lockedUntil: true,
        status: true,
      },
    });
    return worker ? (worker as WorkerCredentials) : null;
  }

  async updateLockout(
    organizationId: OrganizationId,
    workerId: WorkerId,
    state: { failedPinAttempts: number; lockedUntil: Date | null },
  ): Promise<void> {
    await this.db.worker.updateMany({
      where: { id: workerId, organizationId },
      data: state,
    });
  }

  async countActive(organizationId: OrganizationId): Promise<number> {
    return this.db.worker.count({
      where: { organizationId, status: 'ACTIVE', deletedAt: null },
    });
  }
}

export class PrismaPositionRepository implements PositionRepository {
  constructor(private readonly db: DatabaseClient) {}

  async findRule(
    organizationId: OrganizationId,
    positionId: PositionId,
  ): Promise<PositionRule | null> {
    const position = await this.db.position.findFirst({
      where: { id: positionId, organizationId },
      select: {
        id: true,
        changeMode: true,
        status: true,
        capacity: true,
        requiredQualifications: { select: { qualificationId: true } },
      },
    });
    if (!position) return null;
    return this.toRule(organizationId, position);
  }

  async listRulesForSite(
    organizationId: OrganizationId,
    siteId: SiteId,
  ): Promise<readonly PositionRule[]> {
    const positions = await this.db.position.findMany({
      where: { organizationId, siteId, status: 'ACTIVE' },
      select: {
        id: true,
        changeMode: true,
        status: true,
        capacity: true,
        requiredQualifications: { select: { qualificationId: true } },
      },
      orderBy: { code: 'asc' },
    });
    return Promise.all(positions.map((position) => this.toRule(organizationId, position)));
  }

  async findByQrToken(
    organizationId: OrganizationId,
    qrToken: string,
  ): Promise<PositionRule | null> {
    const position = await this.db.position.findFirst({
      // qrToken is globally unique, but the tenant filter still applies: a token from another
      // organization must read as "not recognized", not as a position.
      where: { qrToken, organizationId },
      select: {
        id: true,
        changeMode: true,
        status: true,
        capacity: true,
        requiredQualifications: { select: { qualificationId: true } },
      },
    });
    if (!position) return null;
    return this.toRule(organizationId, position);
  }

  /**
   * Occupancy is only counted when the position actually has a capacity limit — the count is a
   * query per position, and running it for unlimited positions would be pure waste on the
   * position picker's hot path.
   */
  private async toRule(
    organizationId: OrganizationId,
    position: {
      id: string;
      changeMode: PositionRule['changeMode'];
      status: PositionRule['status'];
      capacity: number | null;
      requiredQualifications: { qualificationId: string }[];
    },
  ): Promise<PositionRule> {
    const currentOccupancy =
      position.capacity === null
        ? 0
        : await this.db.positionSession.count({
            where: { organizationId, positionId: position.id, endedAt: null },
          });

    return {
      positionId: position.id as PositionId,
      changeMode: position.changeMode,
      status: position.status,
      requiredQualificationIds: position.requiredQualifications.map(
        (entry) => entry.qualificationId as QualificationId,
      ),
      capacity: position.capacity,
      currentOccupancy,
    };
  }
}

export class PrismaQualificationRepository implements QualificationRepository {
  constructor(private readonly db: DatabaseClient) {}

  async listWorkerHoldings(
    organizationId: OrganizationId,
    workerId: WorkerId,
  ): Promise<readonly WorkerQualificationHolding[]> {
    const holdings = await this.db.workerQualification.findMany({
      where: { organizationId, workerId },
      select: { qualificationId: true, expiresAt: true },
    });
    return holdings.map((holding) => ({
      qualificationId: holding.qualificationId as QualificationId,
      expiresAt: holding.expiresAt,
    }));
  }

  async listExpiringSoon(
    organizationId: OrganizationId,
    withinDays: number,
  ): Promise<readonly { workerId: WorkerId; qualificationId: QualificationId; expiresAt: Date }[]> {
    const cutoff = new Date(Date.now() + withinDays * 86_400_000);
    const rows = await this.db.workerQualification.findMany({
      where: { organizationId, expiresAt: { not: null, lte: cutoff } },
      select: { workerId: true, qualificationId: true, expiresAt: true },
      orderBy: { expiresAt: 'asc' },
    });
    return rows.map((row) => ({
      workerId: row.workerId as WorkerId,
      qualificationId: row.qualificationId as QualificationId,
      expiresAt: row.expiresAt!,
    }));
  }
}

export class PrismaEligibilityRepository implements EligibilityRepository {
  constructor(private readonly db: DatabaseClient) {}

  async listOverridesForWorker(
    organizationId: OrganizationId,
    workerId: WorkerId,
  ): Promise<readonly EligibilityOverride[]> {
    const overrides = await this.db.workerPositionEligibility.findMany({
      where: { organizationId, workerId },
      select: { positionId: true, effect: true, validFrom: true, validTo: true },
    });
    return overrides.map((override) => ({
      positionId: override.positionId as PositionId,
      effect: override.effect,
      validFrom: override.validFrom,
      validTo: override.validTo,
    }));
  }
}

export class PrismaOrganizationPolicyRepository implements OrganizationPolicyRepository {
  constructor(private readonly db: DatabaseClient) {}

  async getPositionPolicy(organizationId: OrganizationId): Promise<{
    requireQualificationByDefault: boolean;
    maxShiftDurationMinutes: number;
    allowWorkerSelfShiftStart: boolean;
  }> {
    const settings = await this.db.organizationSettings.findUnique({
      where: { organizationId },
      select: {
        requireQualificationByDefault: true,
        maxShiftDurationMinutes: true,
        allowWorkerSelfShiftStart: true,
      },
    });

    // Defaults are the strict ones: an organization without a settings row requires
    // qualifications rather than silently allowing everything.
    return (
      settings ?? {
        requireQualificationByDefault: true,
        maxShiftDurationMinutes: 960,
        allowWorkerSelfShiftStart: true,
      }
    );
  }
}
