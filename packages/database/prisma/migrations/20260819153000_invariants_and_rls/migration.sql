-- ---------------------------------------------------------------------------
-- AYtracker v2 — invariants the Prisma schema language cannot express.
--
-- Three groups:
--   1. Partial unique indexes  — "at most one open X" rules that must hold even if two
--      concurrent transactions race. Application-level checks are necessary but not
--      sufficient; these make the race lose at the database.
--   2. Check constraints       — value ranges that must never be violated regardless of which
--      code path wrote the row (imports, backfills, a future integration adapter).
--   3. Composite tenant FKs    — a child row may only reference a parent in the SAME
--      organization. This closes the "attach my shift to another tenant's site" class of bug
--      structurally rather than by review.
--   4. Row Level Security      — defense in depth for the application-layer tenant filter.
--      See docs/multi-tenancy.md § RLS for the rollout model.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. PARTIAL UNIQUE INDEXES
-- ===========================================================================

-- A worker has at most one shift in progress at any moment.
CREATE UNIQUE INDEX "shifts_one_open_per_worker"
  ON "shifts" ("workerId")
  WHERE "status" IN ('ACTIVE', 'ON_BREAK');

-- A shift has at most one open break.
CREATE UNIQUE INDEX "shift_breaks_one_open_per_shift"
  ON "shift_breaks" ("shiftId")
  WHERE "endedAt" IS NULL;

-- The core position-change invariant: never two open position sessions on one shift.
CREATE UNIQUE INDEX "position_sessions_one_open_per_shift"
  ON "position_sessions" ("shiftId")
  WHERE "endedAt" IS NULL;

-- A worker cannot be open on two positions at once, even across shifts.
CREATE UNIQUE INDEX "position_sessions_one_open_per_worker"
  ON "position_sessions" ("workerId")
  WHERE "endedAt" IS NULL;

-- A driver runs at most one trip at a time.
CREATE UNIQUE INDEX "driver_trips_one_open_per_driver"
  ON "driver_trips" ("driverId")
  WHERE "status" IN ('ACTIVE', 'PAUSED');

-- A vehicle is on at most one trip at a time.
CREATE UNIQUE INDEX "driver_trips_one_open_per_vehicle"
  ON "driver_trips" ("vehicleId")
  WHERE "status" IN ('ACTIVE', 'PAUSED');

-- A vehicle has at most one open assignment. Relaxing this is what a future shared-vehicle
-- workflow would have to do explicitly, which is the point of making it a constraint.
CREATE UNIQUE INDEX "vehicle_assignments_one_open_per_vehicle"
  ON "vehicle_assignments" ("vehicleId")
  WHERE "endedAt" IS NULL;

-- A driver holds at most one open assignment.
CREATE UNIQUE INDEX "vehicle_assignments_one_open_per_driver"
  ON "vehicle_assignments" ("driverId")
  WHERE "endedAt" IS NULL;

-- Only one active price per (market, plan, interval) window.
CREATE UNIQUE INDEX "prices_one_active_per_market_plan_interval"
  ON "prices" ("marketId", "planId", "interval")
  WHERE "status" = 'ACTIVE' AND "isPromotional" = false;

-- One live subscription per organization.
CREATE UNIQUE INDEX "subscriptions_one_live_per_org"
  ON "subscriptions" ("organizationId")
  WHERE "status" IN ('TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED');

-- ===========================================================================
-- 2. CHECK CONSTRAINTS
-- ===========================================================================

ALTER TABLE "shifts"
  ADD CONSTRAINT "shifts_end_after_start"
    CHECK ("actualEnd" IS NULL OR "actualStart" IS NULL OR "actualEnd" >= "actualStart"),
  ADD CONSTRAINT "shifts_end_requires_start"
    CHECK ("actualEnd" IS NULL OR "actualStart" IS NOT NULL),
  ADD CONSTRAINT "shifts_non_negative_durations"
    CHECK (("workedSeconds" IS NULL OR "workedSeconds" >= 0)
       AND ("breakSeconds" IS NULL OR "breakSeconds" >= 0));

ALTER TABLE "shift_breaks"
  ADD CONSTRAINT "shift_breaks_end_after_start"
    CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt"),
  ADD CONSTRAINT "shift_breaks_non_negative_duration"
    CHECK ("durationSeconds" IS NULL OR "durationSeconds" >= 0);

ALTER TABLE "position_sessions"
  ADD CONSTRAINT "position_sessions_end_after_start"
    CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt"),
  ADD CONSTRAINT "position_sessions_non_negative_duration"
    CHECK ("durationSeconds" IS NULL OR "durationSeconds" >= 0);

ALTER TABLE "production_entries"
  ADD CONSTRAINT "production_entries_non_negative_quantities"
    CHECK ("goodQuantity" >= 0 AND "defectQuantity" >= 0);

ALTER TABLE "driver_trips"
  ADD CONSTRAINT "driver_trips_end_after_start"
    CHECK ("endedAt" IS NULL OR "startedAt" IS NULL OR "endedAt" >= "startedAt"),
  ADD CONSTRAINT "driver_trips_non_negative_metrics"
    CHECK ("distanceMeters" >= 0
       AND "durationSeconds" >= 0
       AND "pausedSeconds" >= 0
       AND "untrackedSeconds" >= 0),
  ADD CONSTRAINT "driver_trips_odometer_forward"
    CHECK ("endOdometer" IS NULL OR "startOdometer" IS NULL OR "endOdometer" >= "startOdometer");

ALTER TABLE "trip_location_points"
  ADD CONSTRAINT "trip_location_points_valid_coordinates"
    CHECK ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180),
  ADD CONSTRAINT "trip_location_points_non_negative_accuracy"
    CHECK ("accuracyMeters" IS NULL OR "accuracyMeters" >= 0);

ALTER TABLE "tracking_events"
  ADD CONSTRAINT "tracking_events_non_negative_gap"
    CHECK ("gapSeconds" IS NULL OR "gapSeconds" >= 0);

ALTER TABLE "fuel_expenses"
  ADD CONSTRAINT "fuel_expenses_positive_liters"
    CHECK ("liters" > 0),
  ADD CONSTRAINT "fuel_expenses_non_negative_money"
    CHECK ("pricePerLiter" >= 0 AND "totalCost" >= 0),
  ADD CONSTRAINT "fuel_expenses_currency_shape"
    CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "vehicle_expenses"
  ADD CONSTRAINT "vehicle_expenses_currency_shape"
    CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_non_negative_odometer"
    CHECK ("odometerCurrent" >= 0),
  ADD CONSTRAINT "vehicles_non_negative_consumption"
    CHECK ("averageConsumption" IS NULL OR "averageConsumption" >= 0);

ALTER TABLE "prices"
  ADD CONSTRAINT "prices_non_negative_amount"
    CHECK ("amount" >= 0),
  ADD CONSTRAINT "prices_window_ordered"
    CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"),
  ADD CONSTRAINT "prices_currency_shape"
    CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "feature_flags"
  ADD CONSTRAINT "feature_flags_rollout_range"
    CHECK ("rolloutPercent" BETWEEN 0 AND 100);

ALTER TABLE "shift_types"
  ADD CONSTRAINT "shift_types_minute_range"
    CHECK ("startMinute" BETWEEN 0 AND 1439 AND "endMinute" BETWEEN 0 AND 1439);

ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_country_shape"
    CHECK ("countryCode" ~ '^[A-Z]{2}$' AND "billingCountry" ~ '^[A-Z]{2}$');

ALTER TABLE "billing_customers"
  ADD CONSTRAINT "billing_customers_country_shape"
    CHECK ("countryCode" ~ '^[A-Z]{2}$');

-- Sessions must belong to exactly one actor of the declared type.
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_actor_matches_type"
    CHECK (
      ("actorType" = 'USER'   AND "userId"   IS NOT NULL AND "workerId" IS NULL AND "driverId" IS NULL)
   OR ("actorType" = 'WORKER' AND "workerId" IS NOT NULL AND "userId"   IS NULL AND "driverId" IS NULL)
   OR ("actorType" = 'DRIVER' AND "driverId" IS NOT NULL AND "userId"   IS NULL AND "workerId" IS NULL)
    );

-- Worker and driver sessions are always tenant-bound; only a platform-admin user session may
-- exist without an organization (before a tenant is selected).
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_tenant_bound_for_non_users"
    CHECK ("actorType" = 'USER' OR "organizationId" IS NOT NULL);

-- ===========================================================================
-- 3. COMPOSITE TENANT FOREIGN KEYS
-- ===========================================================================
-- Each parent gets a UNIQUE (organizationId, id) so children can reference the pair.
-- MATCH SIMPLE (the default) means a NULL in any FK column skips the check, which is exactly
-- what optional relations need.

ALTER TABLE "sites"             ADD CONSTRAINT "sites_tenant_key"             UNIQUE ("organizationId", "id");
ALTER TABLE "work_areas"        ADD CONSTRAINT "work_areas_tenant_key"        UNIQUE ("organizationId", "id");
ALTER TABLE "positions"         ADD CONSTRAINT "positions_tenant_key"         UNIQUE ("organizationId", "id");
ALTER TABLE "workers"           ADD CONSTRAINT "workers_tenant_key"           UNIQUE ("organizationId", "id");
ALTER TABLE "qualifications"    ADD CONSTRAINT "qualifications_tenant_key"    UNIQUE ("organizationId", "id");
ALTER TABLE "shift_types"       ADD CONSTRAINT "shift_types_tenant_key"       UNIQUE ("organizationId", "id");
ALTER TABLE "shifts"            ADD CONSTRAINT "shifts_tenant_key"            UNIQUE ("organizationId", "id");
ALTER TABLE "position_sessions" ADD CONSTRAINT "position_sessions_tenant_key" UNIQUE ("organizationId", "id");
ALTER TABLE "product_templates" ADD CONSTRAINT "product_templates_tenant_key" UNIQUE ("organizationId", "id");
ALTER TABLE "drivers"           ADD CONSTRAINT "drivers_tenant_key"           UNIQUE ("organizationId", "id");
ALTER TABLE "vehicles"          ADD CONSTRAINT "vehicles_tenant_key"          UNIQUE ("organizationId", "id");
ALTER TABLE "driver_trips"      ADD CONSTRAINT "driver_trips_tenant_key"      UNIQUE ("organizationId", "id");
ALTER TABLE "fuel_expenses"     ADD CONSTRAINT "fuel_expenses_tenant_key"     UNIQUE ("organizationId", "id");

ALTER TABLE "work_areas"
  ADD CONSTRAINT "work_areas_site_same_tenant"
    FOREIGN KEY ("organizationId", "siteId") REFERENCES "sites" ("organizationId", "id") ON DELETE CASCADE;

ALTER TABLE "positions"
  ADD CONSTRAINT "positions_site_same_tenant"
    FOREIGN KEY ("organizationId", "siteId") REFERENCES "sites" ("organizationId", "id") ON DELETE CASCADE,
  ADD CONSTRAINT "positions_work_area_same_tenant"
    FOREIGN KEY ("organizationId", "workAreaId") REFERENCES "work_areas" ("organizationId", "id") ON DELETE RESTRICT;

ALTER TABLE "workers"
  ADD CONSTRAINT "workers_site_same_tenant"
    FOREIGN KEY ("organizationId", "siteId") REFERENCES "sites" ("organizationId", "id") ON DELETE SET NULL;

ALTER TABLE "worker_qualifications"
  ADD CONSTRAINT "worker_qualifications_worker_same_tenant"
    FOREIGN KEY ("organizationId", "workerId") REFERENCES "workers" ("organizationId", "id") ON DELETE CASCADE,
  ADD CONSTRAINT "worker_qualifications_qualification_same_tenant"
    FOREIGN KEY ("organizationId", "qualificationId") REFERENCES "qualifications" ("organizationId", "id") ON DELETE CASCADE;

ALTER TABLE "position_qualifications"
  ADD CONSTRAINT "position_qualifications_position_same_tenant"
    FOREIGN KEY ("organizationId", "positionId") REFERENCES "positions" ("organizationId", "id") ON DELETE CASCADE,
  ADD CONSTRAINT "position_qualifications_qualification_same_tenant"
    FOREIGN KEY ("organizationId", "qualificationId") REFERENCES "qualifications" ("organizationId", "id") ON DELETE CASCADE;

ALTER TABLE "worker_position_eligibility"
  ADD CONSTRAINT "worker_position_eligibility_worker_same_tenant"
    FOREIGN KEY ("organizationId", "workerId") REFERENCES "workers" ("organizationId", "id") ON DELETE CASCADE,
  ADD CONSTRAINT "worker_position_eligibility_position_same_tenant"
    FOREIGN KEY ("organizationId", "positionId") REFERENCES "positions" ("organizationId", "id") ON DELETE CASCADE;

ALTER TABLE "shifts"
  ADD CONSTRAINT "shifts_site_same_tenant"
    FOREIGN KEY ("organizationId", "siteId") REFERENCES "sites" ("organizationId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "shifts_worker_same_tenant"
    FOREIGN KEY ("organizationId", "workerId") REFERENCES "workers" ("organizationId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "shifts_shift_type_same_tenant"
    FOREIGN KEY ("organizationId", "shiftTypeId") REFERENCES "shift_types" ("organizationId", "id") ON DELETE SET NULL;

ALTER TABLE "shift_breaks"
  ADD CONSTRAINT "shift_breaks_shift_same_tenant"
    FOREIGN KEY ("organizationId", "shiftId") REFERENCES "shifts" ("organizationId", "id") ON DELETE CASCADE;

ALTER TABLE "position_sessions"
  ADD CONSTRAINT "position_sessions_shift_same_tenant"
    FOREIGN KEY ("organizationId", "shiftId") REFERENCES "shifts" ("organizationId", "id") ON DELETE CASCADE,
  ADD CONSTRAINT "position_sessions_worker_same_tenant"
    FOREIGN KEY ("organizationId", "workerId") REFERENCES "workers" ("organizationId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "position_sessions_position_same_tenant"
    FOREIGN KEY ("organizationId", "positionId") REFERENCES "positions" ("organizationId", "id") ON DELETE RESTRICT;

ALTER TABLE "production_entries"
  ADD CONSTRAINT "production_entries_shift_same_tenant"
    FOREIGN KEY ("organizationId", "shiftId") REFERENCES "shifts" ("organizationId", "id") ON DELETE CASCADE,
  ADD CONSTRAINT "production_entries_worker_same_tenant"
    FOREIGN KEY ("organizationId", "workerId") REFERENCES "workers" ("organizationId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "production_entries_position_same_tenant"
    FOREIGN KEY ("organizationId", "positionId") REFERENCES "positions" ("organizationId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "production_entries_session_same_tenant"
    FOREIGN KEY ("organizationId", "positionSessionId") REFERENCES "position_sessions" ("organizationId", "id") ON DELETE SET NULL,
  ADD CONSTRAINT "production_entries_template_same_tenant"
    FOREIGN KEY ("organizationId", "productTemplateId") REFERENCES "product_templates" ("organizationId", "id") ON DELETE SET NULL;

ALTER TABLE "drivers"
  ADD CONSTRAINT "drivers_worker_same_tenant"
    FOREIGN KEY ("organizationId", "workerId") REFERENCES "workers" ("organizationId", "id") ON DELETE SET NULL;

ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_site_same_tenant"
    FOREIGN KEY ("organizationId", "siteId") REFERENCES "sites" ("organizationId", "id") ON DELETE SET NULL;

ALTER TABLE "vehicle_assignments"
  ADD CONSTRAINT "vehicle_assignments_driver_same_tenant"
    FOREIGN KEY ("organizationId", "driverId") REFERENCES "drivers" ("organizationId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "vehicle_assignments_vehicle_same_tenant"
    FOREIGN KEY ("organizationId", "vehicleId") REFERENCES "vehicles" ("organizationId", "id") ON DELETE RESTRICT;

ALTER TABLE "driver_trips"
  ADD CONSTRAINT "driver_trips_driver_same_tenant"
    FOREIGN KEY ("organizationId", "driverId") REFERENCES "drivers" ("organizationId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "driver_trips_vehicle_same_tenant"
    FOREIGN KEY ("organizationId", "vehicleId") REFERENCES "vehicles" ("organizationId", "id") ON DELETE RESTRICT;

ALTER TABLE "trip_location_points"
  ADD CONSTRAINT "trip_location_points_trip_same_tenant"
    FOREIGN KEY ("organizationId", "tripId") REFERENCES "driver_trips" ("organizationId", "id") ON DELETE CASCADE;

ALTER TABLE "tracking_events"
  ADD CONSTRAINT "tracking_events_trip_same_tenant"
    FOREIGN KEY ("organizationId", "tripId") REFERENCES "driver_trips" ("organizationId", "id") ON DELETE CASCADE;

ALTER TABLE "fuel_expenses"
  ADD CONSTRAINT "fuel_expenses_vehicle_same_tenant"
    FOREIGN KEY ("organizationId", "vehicleId") REFERENCES "vehicles" ("organizationId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "fuel_expenses_driver_same_tenant"
    FOREIGN KEY ("organizationId", "driverId") REFERENCES "drivers" ("organizationId", "id") ON DELETE SET NULL,
  ADD CONSTRAINT "fuel_expenses_trip_same_tenant"
    FOREIGN KEY ("organizationId", "tripId") REFERENCES "driver_trips" ("organizationId", "id") ON DELETE SET NULL;

ALTER TABLE "vehicle_expenses"
  ADD CONSTRAINT "vehicle_expenses_vehicle_same_tenant"
    FOREIGN KEY ("organizationId", "vehicleId") REFERENCES "vehicles" ("organizationId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "vehicle_expenses_fuel_same_tenant"
    FOREIGN KEY ("organizationId", "fuelExpenseId") REFERENCES "fuel_expenses" ("organizationId", "id") ON DELETE SET NULL;

ALTER TABLE "vehicle_documents"
  ADD CONSTRAINT "vehicle_documents_vehicle_same_tenant"
    FOREIGN KEY ("organizationId", "vehicleId") REFERENCES "vehicles" ("organizationId", "id") ON DELETE CASCADE;

-- ===========================================================================
-- 4. ROW LEVEL SECURITY
-- ===========================================================================
-- Enforcement model (docs/multi-tenancy.md):
--   * The application connects as a NON-OWNER role, so these policies apply to it.
--   * Migrations and maintenance connect as the owner, which is not subject to RLS — that is
--     deliberate, and why RLS is defense in depth rather than the primary control.
--   * The tenant is carried in the `app.organization_id` GUC, set with SET LOCAL inside the
--     request transaction by withTenant() in @aytracker/database.

CREATE OR REPLACE FUNCTION aytracker_current_org() RETURNS text
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.organization_id', true), '')
  $$;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'organization_branding', 'organization_settings', 'organization_members', 'roles',
    'sites', 'work_areas', 'positions', 'workers', 'qualifications',
    'worker_qualifications', 'position_qualifications', 'worker_position_eligibility',
    'shift_types', 'shifts', 'shift_breaks', 'position_sessions',
    'product_templates', 'production_entries',
    'drivers', 'vehicles', 'vehicle_assignments', 'driver_trips',
    'trip_location_points', 'tracking_events', 'fuel_expenses', 'vehicle_expenses',
    'vehicle_documents', 'recommendations', 'audit_logs', 'corrections',
    'organization_entitlements', 'billing_customers', 'subscriptions', 'idempotency_keys'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("organizationId" = aytracker_current_org()) '
      'WITH CHECK ("organizationId" = aytracker_current_org())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END
$$;

-- `roles` also holds system roles with a NULL organizationId, which every tenant may read.
DROP POLICY "roles_tenant_isolation" ON "roles";
CREATE POLICY "roles_tenant_isolation" ON "roles"
  USING ("organizationId" = aytracker_current_org() OR "organizationId" IS NULL)
  WITH CHECK ("organizationId" = aytracker_current_org());

-- The organizations table itself is keyed on `id`, not `organizationId`.
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "organizations_tenant_isolation" ON "organizations"
  USING ("id" = aytracker_current_org())
  WITH CHECK ("id" = aytracker_current_org());
