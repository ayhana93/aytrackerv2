-- ---------------------------------------------------------------------------
-- One tracking engine, two contexts.
--
-- Until now a GPS point could only exist against a driver trip, so there was no way to record
-- an employee's working day at all — the worker portal had no tracking, and the admin map could
-- only ever show vehicles. Adding a second pipeline for workforce location would have produced
-- two sets of admission rules, two distance calculations and two state machines that disagree
-- within a quarter. So instead there is now one owner for every point:
--
--   TrackingSession(context = WORK | DRIVER_TRIP)
--        └── LocationPoint          (tripId set when the fix happened during a trip)
--        └── TrackingEvent
--
-- A worker who drives produces ONE stream. Its points belong to the working day's session and
-- additionally carry the trip — so the day's route and the trip's route are two readings of the
-- same rows, never two copies of them.
--
-- Privacy is structural rather than promised: a point has a NOT NULL session, and a session
-- exists only while a shift or a trip does. There is no row this schema can hold that
-- represents location collected outside authorised working time.
--
-- HAND-WRITTEN, like every migration here. `prisma migrate dev` cannot see the composite
-- `*_same_tenant` foreign keys, the partial unique indexes or the RLS policies and would propose
-- dropping them; `tests/integration/schema-invariants.test.ts` fails the build if they ever
-- actually disappear.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. THE SESSION
-- ===========================================================================

CREATE TYPE "TrackingContext" AS ENUM ('WORK', 'DRIVER_TRIP');

CREATE TABLE "tracking_sessions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "context" "TrackingContext" NOT NULL,
    "workerId" TEXT,
    "driverId" TEXT,
    "shiftId" TEXT,
    "tripId" TEXT,
    "vehicleId" TEXT,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "endedAt" TIMESTAMPTZ(6),
    "distanceMeters" INTEGER NOT NULL DEFAULT 0,
    "untrackedSeconds" INTEGER NOT NULL DEFAULT 0,
    "trackingState" TEXT NOT NULL DEFAULT 'STOPPED',
    "lastPointAt" TIMESTAMPTZ(6),
    "lastLatitude" DECIMAL(9,6),
    "lastLongitude" DECIMAL(9,6),
    "lastSpeedMps" DECIMAL(8,3),
    "lastAccuracyMeters" DECIMAL(8,2),
    "batteryLevel" DECIMAL(4,3),
    "isCharging" BOOLEAN,
    "devicePermission" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tracking_sessions_pkey" PRIMARY KEY ("id")
);

-- A session is *for* something. A WORK session records an employee's day; a DRIVER_TRIP session
-- records a trip. Neither is meaningful without its subject, and a row with both — or with
-- neither — would be a bug that only surfaces as a missing marker on a map.
ALTER TABLE "tracking_sessions"
  ADD CONSTRAINT "tracking_sessions_context_matches_subject"
    CHECK (
      ("context" = 'WORK' AND "workerId" IS NOT NULL AND "tripId" IS NULL)
      OR
      ("context" = 'DRIVER_TRIP' AND "driverId" IS NOT NULL AND "tripId" IS NOT NULL)
    );

ALTER TABLE "tracking_sessions"
  ADD CONSTRAINT "tracking_sessions_end_after_start"
    CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt");

ALTER TABLE "tracking_sessions"
  ADD CONSTRAINT "tracking_sessions_battery_is_a_fraction"
    CHECK ("batteryLevel" IS NULL OR ("batteryLevel" >= 0 AND "batteryLevel" <= 1));

CREATE UNIQUE INDEX "tracking_sessions_shiftId_key" ON "tracking_sessions"("shiftId");
CREATE UNIQUE INDEX "tracking_sessions_tripId_key" ON "tracking_sessions"("tripId");

CREATE INDEX "tracking_sessions_organizationId_context_endedAt_idx"
  ON "tracking_sessions"("organizationId", "context", "endedAt");
CREATE INDEX "tracking_sessions_organizationId_workerId_startedAt_idx"
  ON "tracking_sessions"("organizationId", "workerId", "startedAt");
CREATE INDEX "tracking_sessions_organizationId_driverId_startedAt_idx"
  ON "tracking_sessions"("organizationId", "driverId", "startedAt");
-- The live map's query: every open session in this organization, newest fix first.
CREATE INDEX "tracking_sessions_organizationId_endedAt_lastPointAt_idx"
  ON "tracking_sessions"("organizationId", "endedAt", "lastPointAt");

CREATE UNIQUE INDEX "tracking_sessions_tenant_key"
  ON "tracking_sessions"("organizationId", "id");

-- One open WORK session per worker, and one open DRIVER_TRIP session per driver. The
-- application checks both for a decent error message; these indexes are what actually decide
-- it when two devices race.
CREATE UNIQUE INDEX "tracking_sessions_one_open_work_per_worker"
  ON "tracking_sessions" ("workerId")
  WHERE "endedAt" IS NULL AND "context" = 'WORK';

CREATE UNIQUE INDEX "tracking_sessions_one_open_trip_per_driver"
  ON "tracking_sessions" ("driverId")
  WHERE "endedAt" IS NULL AND "context" = 'DRIVER_TRIP';

ALTER TABLE "tracking_sessions"
  ADD CONSTRAINT "tracking_sessions_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "tracking_sessions_workerId_fkey"
    FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "tracking_sessions_driverId_fkey"
    FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "tracking_sessions_shiftId_fkey"
    FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "tracking_sessions_tripId_fkey"
    FOREIGN KEY ("tripId") REFERENCES "driver_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "tracking_sessions_vehicleId_fkey"
    FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Composite tenant keys, so a session cannot reference another organization's worker, driver,
-- shift, trip or vehicle. See docs/multi-tenancy.md.
ALTER TABLE "tracking_sessions"
  ADD CONSTRAINT "tracking_sessions_worker_same_tenant"
    FOREIGN KEY ("organizationId", "workerId") REFERENCES "workers" ("organizationId", "id") ON DELETE CASCADE,
  ADD CONSTRAINT "tracking_sessions_driver_same_tenant"
    FOREIGN KEY ("organizationId", "driverId") REFERENCES "drivers" ("organizationId", "id") ON DELETE CASCADE,
  ADD CONSTRAINT "tracking_sessions_shift_same_tenant"
    FOREIGN KEY ("organizationId", "shiftId") REFERENCES "shifts" ("organizationId", "id") ON DELETE CASCADE,
  ADD CONSTRAINT "tracking_sessions_trip_same_tenant"
    FOREIGN KEY ("organizationId", "tripId") REFERENCES "driver_trips" ("organizationId", "id") ON DELETE CASCADE,
  ADD CONSTRAINT "tracking_sessions_vehicle_same_tenant"
    FOREIGN KEY ("organizationId", "vehicleId") REFERENCES "vehicles" ("organizationId", "id") ON DELETE SET NULL;

-- ===========================================================================
-- 2. BACKFILL: EVERY EXISTING TRIP GETS ITS SESSION
-- ===========================================================================
-- Done before the points table is repointed, so no point is ever left without an owner. The
-- session inherits the trip's own live state rather than being invented fresh — an in-flight
-- trip must not read as STOPPED for the minute after a deploy.

INSERT INTO "tracking_sessions" (
  "id", "organizationId", "context", "driverId", "tripId", "vehicleId",
  "startedAt", "endedAt", "distanceMeters", "untrackedSeconds",
  "trackingState", "lastPointAt", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  t."organizationId",
  'DRIVER_TRIP',
  t."driverId",
  t."id",
  t."vehicleId",
  COALESCE(t."startedAt", t."createdAt"),
  t."endedAt",
  t."distanceMeters",
  t."untrackedSeconds",
  t."trackingState",
  t."lastPointAt",
  t."createdAt",
  now()
FROM "driver_trips" t;

-- ===========================================================================
-- 3. THE POINTS TABLE BECOMES SHARED
-- ===========================================================================
-- Renamed rather than replaced: the rows are the same GPS history, and copying a high-volume
-- table to change its name would be an outage for no benefit. `tripId` survives as an overlay
-- and becomes nullable, because ordinary working time has no trip.

ALTER TABLE "trip_location_points" RENAME TO "location_points";

ALTER INDEX "trip_location_points_pkey" RENAME TO "location_points_pkey";
ALTER INDEX "trip_location_points_organizationId_tripId_timestamp_idx"
  RENAME TO "location_points_organizationId_tripId_timestamp_idx";
ALTER INDEX "trip_location_points_organizationId_timestamp_idx"
  RENAME TO "location_points_organizationId_timestamp_idx";

ALTER TABLE "location_points"
  RENAME CONSTRAINT "trip_location_points_organizationId_fkey" TO "location_points_organizationId_fkey";
ALTER TABLE "location_points"
  RENAME CONSTRAINT "trip_location_points_tripId_fkey" TO "location_points_tripId_fkey";
ALTER TABLE "location_points"
  RENAME CONSTRAINT "trip_location_points_trip_same_tenant" TO "location_points_trip_same_tenant";
ALTER TABLE "location_points"
  RENAME CONSTRAINT "trip_location_points_valid_coordinates" TO "location_points_valid_coordinates";
ALTER TABLE "location_points"
  RENAME CONSTRAINT "trip_location_points_non_negative_accuracy" TO "location_points_non_negative_accuracy";

ALTER TABLE "location_points" ADD COLUMN "trackingSessionId" TEXT;

UPDATE "location_points" p
   SET "trackingSessionId" = s."id"
  FROM "tracking_sessions" s
 WHERE s."tripId" = p."tripId";

-- Nothing may be left unowned. If the backfill missed a row the migration must fail here rather
-- than leave a point nobody can attribute or delete under a retention policy.
ALTER TABLE "location_points" ALTER COLUMN "trackingSessionId" SET NOT NULL;
ALTER TABLE "location_points" ALTER COLUMN "tripId" DROP NOT NULL;

CREATE INDEX "location_points_organizationId_trackingSessionId_timestamp_idx"
  ON "location_points"("organizationId", "trackingSessionId", "timestamp");

ALTER TABLE "location_points"
  ADD CONSTRAINT "location_points_trackingSessionId_fkey"
    FOREIGN KEY ("trackingSessionId") REFERENCES "tracking_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "location_points_session_same_tenant"
    FOREIGN KEY ("organizationId", "trackingSessionId") REFERENCES "tracking_sessions" ("organizationId", "id") ON DELETE CASCADE;

-- ===========================================================================
-- 4. TRACKING EVENTS FOLLOW THE POINTS
-- ===========================================================================
-- A working day has interruptions whether or not anyone is driving, so the event log belongs to
-- the session. `tripId` stays, nullable, so a trip's own event list is still one indexed read.

ALTER TABLE "tracking_events" ADD COLUMN "trackingSessionId" TEXT;

UPDATE "tracking_events" e
   SET "trackingSessionId" = s."id"
  FROM "tracking_sessions" s
 WHERE s."tripId" = e."tripId";

ALTER TABLE "tracking_events" ALTER COLUMN "trackingSessionId" SET NOT NULL;
ALTER TABLE "tracking_events" ALTER COLUMN "tripId" DROP NOT NULL;

CREATE INDEX "tracking_events_organizationId_trackingSessionId_occurredAt_idx"
  ON "tracking_events"("organizationId", "trackingSessionId", "occurredAt");

ALTER TABLE "tracking_events"
  ADD CONSTRAINT "tracking_events_trackingSessionId_fkey"
    FOREIGN KEY ("trackingSessionId") REFERENCES "tracking_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "tracking_events_session_same_tenant"
    FOREIGN KEY ("organizationId", "trackingSessionId") REFERENCES "tracking_sessions" ("organizationId", "id") ON DELETE CASCADE;

-- ===========================================================================
-- 5. ROW-LEVEL SECURITY
-- ===========================================================================
-- The third of the three defences. `location_points` already carries its policy under the old
-- name — RLS survives a table rename — so only the new table needs one.

ALTER TABLE "tracking_sessions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tracking_sessions_tenant_isolation" ON "tracking_sessions"
  USING ("organizationId" = aytracker_current_org())
  WITH CHECK ("organizationId" = aytracker_current_org());

-- The renamed table keeps its policy, but not its policy's name. Renaming it too keeps the
-- invariant test — which looks policies up by name — meaningful rather than merely passing.
ALTER POLICY "trip_location_points_tenant_isolation" ON "location_points"
  RENAME TO "location_points_tenant_isolation";
