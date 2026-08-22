-- ---------------------------------------------------------------------------
-- Places that matter, and driving too fast between them.
--
-- Two questions an operations manager asks that the point stream could not yet answer:
--
--   "Did they get there, and how long were they there?"  -> geofences and visits
--   "Is anyone driving my vans too fast?"                -> speed alerts
--
-- Both are derived from points that are already being collected. Neither adds a new collection
-- context, a new device permission, or a reason to track anybody outside an authorised session:
-- a geofence visit is an observation about a route that already exists in the record.
--
-- Three decisions are worth reading before changing anything here.
--
-- A geofence is a CIRCLE, not a polygon. A radius is something a dispatcher sets from a phone
-- in ten seconds and can reason about afterwards; a polygon needs an editor and answers a
-- question ("exactly where is the boundary") that nothing in this product asks.
--
-- A VISIT is a row, and an open row means "inside right now". That is what lets the live screens
-- answer "who is on site" with one indexed read, and it is why there is no separate state table
-- to fall out of step with the visits.
--
-- The speed LIMIT IS NULL BY DEFAULT. There is no national default and no guess from the road
-- type. Reporting an employee for exceeding a number their employer never set is not a feature,
-- and it is the sort of number that ends up quoted in a disciplinary meeting.
--
-- HAND-WRITTEN, like every migration here. `prisma migrate dev` cannot see the composite
-- `*_same_tenant` foreign keys, the partial unique indexes or the RLS policies and would propose
-- dropping them; `tests/integration/schema-invariants.test.ts` fails the build if they ever
-- actually disappear.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. NEW EVENT TYPES
-- ===========================================================================
-- The event log already carries every neutral, factual tracking transition. A fence crossing
-- and a speeding stretch are two more of those, so they go in the same log rather than into
-- tables of their own — one place to read "what happened on this session, in order".

ALTER TYPE "TrackingEventType" ADD VALUE IF NOT EXISTS 'GEOFENCE_ENTER';
ALTER TYPE "TrackingEventType" ADD VALUE IF NOT EXISTS 'GEOFENCE_EXIT';
ALTER TYPE "TrackingEventType" ADD VALUE IF NOT EXISTS 'SPEED_EXCEEDED';

-- ===========================================================================
-- 2. POLICY
-- ===========================================================================

ALTER TABLE "organization_settings"
  ADD COLUMN "speedLimitKph" INTEGER,
  ADD COLUMN "speedSustainedSeconds" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "speedCooldownSeconds" INTEGER NOT NULL DEFAULT 600,
  ADD COLUMN "geofenceExitHysteresisMeters" INTEGER NOT NULL DEFAULT 40,
  ADD COLUMN "geofenceDebounceSeconds" INTEGER NOT NULL DEFAULT 90;

-- A limit of zero would mean "alert on everything", which nobody wants and which reads as a
-- mistake rather than a policy. Off is expressed by NULL.
ALTER TABLE "organization_settings"
  ADD CONSTRAINT "organization_settings_speed_limit_is_a_speed"
    CHECK ("speedLimitKph" IS NULL OR ("speedLimitKph" > 0 AND "speedLimitKph" <= 300));

ALTER TABLE "organization_settings"
  ADD CONSTRAINT "organization_settings_speed_windows_are_positive"
    CHECK ("speedSustainedSeconds" > 0 AND "speedCooldownSeconds" >= 0);

ALTER TABLE "organization_settings"
  ADD CONSTRAINT "organization_settings_geofence_tuning_is_sane"
    CHECK ("geofenceExitHysteresisMeters" >= 0 AND "geofenceDebounceSeconds" >= 0);

-- ===========================================================================
-- 3. GEOFENCES
-- ===========================================================================

CREATE TYPE "GeofenceKind" AS ENUM ('SITE', 'CUSTOMER', 'RESTRICTED', 'OTHER');

CREATE TABLE "geofences" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "GeofenceKind" NOT NULL DEFAULT 'CUSTOMER',
    "centerLatitude" DECIMAL(9,6) NOT NULL,
    "centerLongitude" DECIMAL(9,6) NOT NULL,
    "radiusMeters" INTEGER NOT NULL,
    "siteId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "geofences_pkey" PRIMARY KEY ("id")
);

-- Coordinates are coordinates. The same check the points table carries, for the same reason:
-- a swapped latitude and longitude is the most common way a fence ends up in the Gulf of Guinea.
ALTER TABLE "geofences"
  ADD CONSTRAINT "geofences_center_is_on_earth"
    CHECK (
      "centerLatitude" >= -90 AND "centerLatitude" <= 90
      AND "centerLongitude" >= -180 AND "centerLongitude" <= 180
    );

-- Below 20 m a fence is inside ordinary GPS error and would fire on a phone standing still;
-- above 50 km it is not a place. Both ends are mistakes, not preferences.
ALTER TABLE "geofences"
  ADD CONSTRAINT "geofences_radius_is_a_place"
    CHECK ("radiusMeters" >= 20 AND "radiusMeters" <= 50000);

CREATE INDEX "geofences_organizationId_isActive_idx" ON "geofences"("organizationId", "isActive");
CREATE UNIQUE INDEX "geofences_tenant_key" ON "geofences"("organizationId", "id");

ALTER TABLE "geofences"
  ADD CONSTRAINT "geofences_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "geofences_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  -- The second of the three tenant defences: a fence cannot borrow another tenant's site.
  ADD CONSTRAINT "geofences_site_same_tenant"
    FOREIGN KEY ("organizationId", "siteId") REFERENCES "sites" ("organizationId", "id") ON DELETE SET NULL;

-- ===========================================================================
-- 4. VISITS
-- ===========================================================================

CREATE TABLE "geofence_visits" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "geofenceId" TEXT NOT NULL,
    "trackingSessionId" TEXT NOT NULL,
    "tripId" TEXT,
    "enteredAt" TIMESTAMPTZ(6) NOT NULL,
    "exitedAt" TIMESTAMPTZ(6),
    "dwellSeconds" INTEGER NOT NULL DEFAULT 0,
    "entryLatitude" DECIMAL(9,6) NOT NULL,
    "entryLongitude" DECIMAL(9,6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "geofence_visits_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "geofence_visits"
  ADD CONSTRAINT "geofence_visits_end_after_start"
    CHECK ("exitedAt" IS NULL OR "exitedAt" >= "enteredAt");

ALTER TABLE "geofence_visits"
  ADD CONSTRAINT "geofence_visits_dwell_is_not_negative"
    CHECK ("dwellSeconds" >= 0);

-- Visits are RECOMPUTED from the stored points whenever a batch changes the day — that is what
-- makes a late offline replay correct the record instead of appending a second version of it.
-- This index is what the recomputation upserts on.
CREATE UNIQUE INDEX "geofence_visits_occurrence_key"
  ON "geofence_visits"("trackingSessionId", "geofenceId", "enteredAt");

CREATE INDEX "geofence_visits_organizationId_geofenceId_enteredAt_idx"
  ON "geofence_visits"("organizationId", "geofenceId", "enteredAt");
-- "Who is on site right now": the open visits.
CREATE INDEX "geofence_visits_organizationId_exitedAt_idx"
  ON "geofence_visits"("organizationId", "exitedAt");

ALTER TABLE "geofence_visits"
  ADD CONSTRAINT "geofence_visits_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "geofence_visits_geofenceId_fkey"
    FOREIGN KEY ("geofenceId") REFERENCES "geofences"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "geofence_visits_trackingSessionId_fkey"
    FOREIGN KEY ("trackingSessionId") REFERENCES "tracking_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "geofence_visits_tripId_fkey"
    FOREIGN KEY ("tripId") REFERENCES "driver_trips"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  -- Every parent, checked as a tenant pair. A visit cannot pair one tenant's fence with
  -- another's session, whatever the application layer believes.
  ADD CONSTRAINT "geofence_visits_geofence_same_tenant"
    FOREIGN KEY ("organizationId", "geofenceId") REFERENCES "geofences" ("organizationId", "id") ON DELETE CASCADE,
  ADD CONSTRAINT "geofence_visits_session_same_tenant"
    FOREIGN KEY ("organizationId", "trackingSessionId") REFERENCES "tracking_sessions" ("organizationId", "id") ON DELETE CASCADE,
  ADD CONSTRAINT "geofence_visits_trip_same_tenant"
    FOREIGN KEY ("organizationId", "tripId") REFERENCES "driver_trips" ("organizationId", "id") ON DELETE SET NULL;

-- ===========================================================================
-- 5. ROW-LEVEL SECURITY
-- ===========================================================================
-- The third defence. A geofence is a customer address and a visit is somebody's whereabouts;
-- both are exactly the kind of row that must not leak across a tenant boundary because of one
-- forgotten WHERE clause.

ALTER TABLE "geofences" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "geofences_tenant_isolation" ON "geofences"
  USING ("organizationId" = aytracker_current_org())
  WITH CHECK ("organizationId" = aytracker_current_org());

ALTER TABLE "geofence_visits" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "geofence_visits_tenant_isolation" ON "geofence_visits"
  USING ("organizationId" = aytracker_current_org())
  WITH CHECK ("organizationId" = aytracker_current_org());
