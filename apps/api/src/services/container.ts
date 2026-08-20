import { InProcessEventBus, systemClock, type Clock, type EventBus } from '@aytracker/domain';
import { getPrismaClient, type PrismaClient } from '@aytracker/database';
import type { AppConfig } from '@aytracker/config';
import type { CountryCode, OrganizationId } from '@aytracker/types';
import {
  PrismaEligibilityRepository,
  PrismaOrganizationPolicyRepository,
  PrismaPositionRepository,
  PrismaQualificationRepository,
  PrismaWorkerRepository,
  WorkforceQueryService,
} from '@aytracker/module-workforce';
import {
  DrivingCommandService,
  PrismaIdempotencyStore,
  PrismaShiftTransactionRunner,
  ShiftCommandService,
  type IdempotencyStore,
} from '@aytracker/module-shifts';
import {
  PrismaDriverTransactionRunner,
  PrismaDriverVehicleAccess,
  TripCommandService,
} from '@aytracker/module-drivers';
import { AuthService } from './auth-service.js';
import { RegistrationService } from './registration-service.js';
import { SessionService } from './session-service.js';
import { EntitlementService } from './entitlement-service.js';
import { MarketService } from './market-service.js';

/**
 * Composition root.
 *
 * Everything is constructed once, here, and wired by hand. No DI container: the graph is small
 * enough that explicit construction is clearer than a framework, and it makes the module
 * boundaries visible — you can read off exactly which ports each module was given.
 */

export interface BillingCustomerInfo {
  readonly countryCode: CountryCode;
  readonly isBusiness: boolean;
  readonly vatValidatedAt: Date | null;
}

export interface AppServices {
  readonly config: AppConfig;
  readonly prisma: PrismaClient;
  readonly clock: Clock;
  readonly events: EventBus;

  readonly auth: AuthService;
  readonly registration: RegistrationService;
  readonly sessions: SessionService;
  readonly entitlements: EntitlementService;
  readonly markets: MarketService;

  readonly workforce: WorkforceQueryService;
  readonly shifts: ShiftCommandService;
  /** The worker → driver handoff. Shares the shift transaction runner, by design. */
  readonly driving: DrivingCommandService;
  readonly trips: TripCommandService;
  readonly idempotency: IdempotencyStore;

  /** Seller's country of establishment. Configuration, never request data. */
  readonly sellerCountry: CountryCode;
  billingCustomer(organizationId: OrganizationId): Promise<BillingCustomerInfo>;
}

export function buildServices(config: AppConfig, clock: Clock = systemClock): AppServices {
  const prisma = getPrismaClient({ databaseUrl: config.env.DATABASE_URL });

  const events = new InProcessEventBus((error, event) => {
    // A failing subscriber must never fail the command that produced the event, but it must
    // never disappear either.
    console.error(`[events] handler failed for ${event.name}`, error);
  });

  const workforce = new WorkforceQueryService(
    new PrismaWorkerRepository(prisma),
    new PrismaPositionRepository(prisma),
    new PrismaQualificationRepository(prisma),
    new PrismaEligibilityRepository(prisma),
    new PrismaOrganizationPolicyRepository(prisma),
  );

  const shiftTransactions = new PrismaShiftTransactionRunner(prisma);

  const shifts = new ShiftCommandService(shiftTransactions, workforce, events, clock);

  // Constructed with the same transaction runner as `shifts`: the position change, the vehicle
  // assignment and the trip have to commit together or the handoff is half-applied.
  const driving = new DrivingCommandService(shiftTransactions, workforce, events, clock);

  const trips = new TripCommandService(
    new PrismaDriverTransactionRunner(prisma),
    new PrismaDriverVehicleAccess(prisma),
    events,
    clock,
  );

  return {
    config,
    prisma,
    clock,
    events,
    auth: new AuthService(prisma),
    registration: new RegistrationService(prisma),
    sessions: new SessionService(prisma),
    entitlements: new EntitlementService(prisma),
    markets: new MarketService(prisma, config.env.DEFAULT_MARKET),
    workforce,
    shifts,
    driving,
    trips,
    idempotency: new PrismaIdempotencyStore(prisma),
    // Seller establishment. Bulgaria initially; moving it is a configuration change plus a
    // conversation with an accountant, not a code change.
    sellerCountry: 'BG',
    async billingCustomer(organizationId: OrganizationId): Promise<BillingCustomerInfo> {
      const customer = await prisma.billingCustomer.findUnique({
        where: { organizationId },
        select: { countryCode: true, isBusiness: true, vatValidatedAt: true },
      });
      if (customer) return customer;

      // No billing customer yet (trial): fall back to the organization's declared billing
      // country, and treat them as a business without a validated VAT number — the
      // conservative assumption, which charges tax rather than omitting it.
      const organization = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { billingCountry: true },
      });
      return {
        countryCode: organization?.billingCountry ?? 'BG',
        isBusiness: true,
        vatValidatedAt: null,
      };
    },
  };
}
