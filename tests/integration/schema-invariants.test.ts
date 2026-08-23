import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  disconnectTestClient,
  getTestClient,
  seedPlatformReferenceData,
} from '../helpers/database.js';

/**
 * The invariants that live in the database, not in the code.
 *
 * `20260819153000_invariants_and_rls` promised these would be guarded. This is the guard.
 *
 * Why it exists: Prisma's `migrate diff` does not know about hand-written partial unique indexes,
 * check constraints or composite `(organizationId, id)` foreign keys, and will happily generate a
 * migration that drops them. Nothing else in the suite would notice — every application-level
 * check would still pass, and the loss would only surface as a cross-tenant row or a lost race
 * under concurrency, in production, months later.
 *
 * These tests read the live catalog rather than the migration files, so they fail if a migration
 * removes an invariant regardless of how it was removed.
 *
 * See docs/database.md and docs/multi-tenancy.md.
 */

const prisma = getTestClient();

beforeAll(async () => {
  await seedPlatformReferenceData();
});

afterAll(async () => {
  await disconnectTestClient();
});

async function indexNames(): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
  );
  return new Set(rows.map((row) => row.indexname));
}

async function constraintNames(type: 'c' | 'u' | 'f'): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<{ conname: string }[]>(
    `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.contype = '${type}'`,
  );
  return new Set(rows.map((row) => row.conname));
}

/**
 * "At most one open X" rules.
 *
 * Each of these is checked in application code too — for a decent error message — and enforced
 * here for correctness, because two concurrent requests can both pass the application check.
 * Deleting one of these indexes turns a hard guarantee into a hopeful one.
 */
const PARTIAL_UNIQUE_INDEXES = [
  'shifts_one_open_per_worker',
  'shift_breaks_one_open_per_shift',
  'position_sessions_one_open_per_shift',
  'position_sessions_one_open_per_worker',
  'driver_trips_one_open_per_driver',
  'driver_trips_one_open_per_vehicle',
  'vehicle_assignments_one_open_per_vehicle',
  'vehicle_assignments_one_open_per_driver',
  // One phone, one stream. Two open sessions for the same person would silently split a day's
  // distance between them.
  'tracking_sessions_one_open_work_per_worker',
  'tracking_sessions_one_open_trip_per_driver',
  'prices_one_active_per_market_plan_interval',
  'subscriptions_one_live_per_org',
] as const;

const CHECK_CONSTRAINTS = [
  'shifts_end_after_start',
  'shifts_end_requires_start',
  'shifts_non_negative_durations',
  'shift_breaks_end_after_start',
  'shift_breaks_non_negative_duration',
  'position_sessions_end_after_start',
  'position_sessions_non_negative_duration',
  'production_entries_non_negative_quantities',
  'driver_trips_end_after_start',
  'driver_trips_non_negative_metrics',
  'driver_trips_odometer_forward',
  // Renamed with the table when `trip_location_points` became `location_points`: the same rows,
  // now owned by a tracking session rather than by a trip.
  'location_points_valid_coordinates',
  'location_points_non_negative_accuracy',
  'tracking_events_non_negative_gap',
  // A session is *for* something. A row with both a worker and a trip — or with neither — is a
  // marker the live map cannot label and a stream nobody can attribute.
  'tracking_sessions_context_matches_subject',
  'tracking_sessions_end_after_start',
  'tracking_sessions_battery_is_a_fraction',
  'driver_trips_planned_distance_positive',
  'organization_settings_fuel_price_positive',
  'fuel_expenses_positive_liters',
  'fuel_expenses_non_negative_money',
  'fuel_expenses_currency_shape',
  'vehicle_expenses_currency_shape',
  'vehicles_non_negative_odometer',
  'vehicles_non_negative_consumption',
  'prices_non_negative_amount',
  'prices_window_ordered',
  'prices_currency_shape',
  'feature_flags_rollout_range',
  'shift_types_minute_range',
  'organizations_country_shape',
  'billing_customers_country_shape',
  'sessions_actor_matches_type',
  'sessions_tenant_bound_for_non_users',
  // A fence has to be a place: on Earth, and neither smaller than GPS error nor the size of a
  // county. Both ends of that range are mistakes rather than preferences.
  'geofences_center_is_on_earth',
  'geofences_radius_is_a_place',
  'geofence_visits_end_after_start',
  'geofence_visits_dwell_is_not_negative',
  // A speed limit of zero would mean "alert on everything". Off is expressed by NULL.
  'organization_settings_speed_limit_is_a_speed',
  'organization_settings_speed_windows_are_positive',
  'organization_settings_geofence_tuning_is_sane',
] as const;

describe('partial unique indexes', () => {
  it.each(PARTIAL_UNIQUE_INDEXES)('%s exists', async (name) => {
    expect(await indexNames()).toContain(name);
  });

  it('every one of them is partial, not a plain unique index', async () => {
    // A partial index that lost its WHERE clause would forbid a worker from ever having a second
    // shift, rather than a second *open* shift. Same name, opposite meaning.
    const rows = await prisma.$queryRawUnsafe<{ indexname: string; indexdef: string }[]>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
      [...PARTIAL_UNIQUE_INDEXES],
    );
    expect(rows).toHaveLength(PARTIAL_UNIQUE_INDEXES.length);
    for (const row of rows) {
      expect(row.indexdef, `${row.indexname} lost its WHERE clause`).toMatch(/WHERE/i);
      expect(row.indexdef).toMatch(/CREATE UNIQUE INDEX/i);
    }
  });
});

describe('check constraints', () => {
  it('all of them are present', async () => {
    const present = await constraintNames('c');
    const missing = CHECK_CONSTRAINTS.filter((name) => !present.has(name));
    expect(missing).toEqual([]);
  });
});

describe('composite tenant foreign keys', () => {
  /**
   * A child row may only point at a parent in the same organization. This is what makes "attach
   * my shift to another tenant's site" structurally impossible rather than a thing reviewers have
   * to catch.
   */
  it('every same_tenant foreign key is still in place', async () => {
    const rows = await prisma.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public' AND c.contype = 'f' AND c.conname LIKE '%same_tenant%'`,
    );
    // 36 at the time the invariants migration landed. The assertion is a floor, not an equality:
    // adding a tenant table should add one, and that is not a regression.
    expect(rows.length).toBeGreaterThanOrEqual(36);
  });

  it('every same_tenant foreign key references two columns', async () => {
    // A one-column version would be an ordinary foreign key wearing the name of a tenant guard.
    const rows = await prisma.$queryRawUnsafe<{ conname: string; columns: number }[]>(
      `SELECT c.conname, cardinality(c.conkey)::int AS columns
         FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public' AND c.contype = 'f' AND c.conname LIKE '%same_tenant%'`,
    );
    const degraded = rows.filter((row) => row.columns !== 2);
    expect(degraded).toEqual([]);
  });

  it('every tenant table has the (organizationId, id) key those foreign keys point at', async () => {
    // The composite FKs are only possible because the parent carries this unique key. Losing it
    // would force the FKs to be dropped with it.
    const rows = await prisma.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public' AND c.contype = 'u' AND c.conname LIKE '%_tenant_key'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(13);
  });
});

/**
 * The two tables that carry `organizationId` and are deliberately outside RLS.
 *
 * Both are read *before* a tenant is known, so a policy keyed on `app.organization_id` would
 * require the tenant in order to discover the tenant:
 *
 *   sessions       looked up by tokenHash; the row that comes back is what sets the organization.
 *   auth_attempts  counted during login for lockout, including attempts naming an organization
 *                  that does not exist — which is exactly the case worth counting.
 *
 * Listing them here rather than skipping the check keeps the assertion sharp: adding a genuine
 * tenant table without RLS still fails, and widening this list is a visible decision in a diff.
 * See docs/multi-tenancy.md.
 */
const RLS_EXEMPT = ['sessions', 'auth_attempts'] as const;

describe('row level security', () => {
  /**
   * Defense in depth behind the application's tenant filter. The risk this test exists for is a
   * new tenant table being added without RLS — which no other test would notice, because the
   * application filter would still scope every query correctly right up until one query forgot to.
   */
  it('every table with an organizationId column has RLS enabled', async () => {
    const rows = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT c.relname AS tablename
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND a.attname = 'organizationId'
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND c.relrowsecurity = false`,
    );
    expect(rows.map((row) => row.tablename).sort()).toEqual([...RLS_EXEMPT].sort());
  });

  it('the organizations table itself is protected on its own primary key', async () => {
    const rows = await prisma.$queryRawUnsafe<{ relrowsecurity: boolean }[]>(
      `SELECT c.relrowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'organizations'`,
    );
    expect(rows[0]?.relrowsecurity).toBe(true);
  });

  it('every RLS-enabled table actually carries a policy', async () => {
    // RLS enabled with no policy denies everything, which fails loudly. RLS enabled with a policy
    // that was dropped is the same thing, and is the more likely accident.
    const rows = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT c.relname AS tablename
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relrowsecurity = true
          AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)`,
    );
    expect(rows.map((row) => row.tablename)).toEqual([]);
  });
});

describe('the location point stream', () => {
  /**
   * One fix per session per instant.
   *
   * Not a partial index and not a business rule about "open" anything — a plain uniqueness
   * guarantee on the busiest table in the product. It is what stops a device queue re-sending a
   * batch whose acknowledgement was lost from storing the afternoon twice, and `appendMany`
   * skips against it rather than failing the driver's upload.
   */
  it('cannot hold two fixes for one session at one instant', async () => {
    expect(await indexNames()).toContain('location_points_session_instant_key');
  });

  it('has not grown a second index of the same shape', async () => {
    // The unique index replaced the plain one rather than joining it: two indexes on the same
    // three columns would double the write cost of every ingested point and buy nothing.
    const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'location_points'
          AND indexdef LIKE '%"organizationId", "trackingSessionId", "timestamp"%'`,
    );
    expect(rows.map((row) => row.indexname)).toEqual(['location_points_session_instant_key']);
  });
});

describe('the driving handoff schema', () => {
  it('allows exactly one trip per position session', async () => {
    // What makes closing a position session able to find and close the trip it owns.
    expect(await indexNames()).toContain('driver_trips_positionSessionId_key');
  });

  it('permits a worker session to carry a driver id', async () => {
    // The handoff elevates the worker's own session rather than issuing a second one, so the
    // actor-shape constraint has to allow WORKER + driverId. If a later migration tightened this
    // back, the handoff would fail at the last step — after the position had already moved.
    const rows = await prisma.$queryRawUnsafe<{ definition: string }[]>(
      `SELECT pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public' AND c.conname = 'sessions_actor_matches_type'`,
    );
    expect(rows[0]?.definition).toMatch(/WORKER/);
  });
});
