-- ---------------------------------------------------------------------------
-- Driving positions: the worker → driver handoff.
--
-- A position can now be of kind DRIVING. Occupying one opens a driving context — a vehicle
-- assignment and a trip — alongside the position session, and leaving it closes that context.
--
-- HAND-WRITTEN, deliberately. `prisma migrate dev` cannot see the composite `*_same_tenant`
-- foreign keys or the partial unique indexes from the invariants migration, so it proposes
-- dropping all of them. Any migration touching these tables must be written by hand or have the
-- spurious DROP statements stripped. `tests/integration/schema-invariants.test.ts` fails the
-- build if they ever actually disappear.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. POSITION KIND
-- ===========================================================================

CREATE TYPE "PositionKind" AS ENUM ('STANDARD', 'DRIVING');

ALTER TABLE "positions"
  ADD COLUMN "kind" "PositionKind" NOT NULL DEFAULT 'STANDARD';

-- A driving position has no physical capacity — the constraint is the fleet, not the floor.
ALTER TABLE "positions"
  ADD CONSTRAINT "positions_driving_has_no_capacity"
    CHECK ("kind" <> 'DRIVING' OR "capacity" IS NULL);

-- ===========================================================================
-- 2. AUTOMATIC VEHICLE ASSIGNMENTS
-- ===========================================================================
-- Distinguishes an assignment the handoff created for one shift from one a fleet manager made
-- deliberately. Only the automatic kind is closed when the worker leaves the driving position;
-- ending a manual assignment because someone clocked out would silently undo a real decision.

ALTER TABLE "vehicle_assignments"
  ADD COLUMN "isAutomatic" BOOLEAN NOT NULL DEFAULT false;

-- ===========================================================================
-- 3. TRIP ↔ POSITION SESSION
-- ===========================================================================
-- The link that stops a worker being recorded at Machine 2 while a trip of theirs is still
-- running: closing the session closes the trip, in the same transaction.

ALTER TABLE "driver_trips"
  ADD COLUMN "positionSessionId" TEXT;

CREATE UNIQUE INDEX "driver_trips_positionSessionId_key"
  ON "driver_trips" ("positionSessionId");

ALTER TABLE "driver_trips"
  ADD CONSTRAINT "driver_trips_positionSessionId_fkey"
    FOREIGN KEY ("positionSessionId") REFERENCES "position_sessions" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant integrity for the new reference, matching every other cross-entity link.
ALTER TABLE "driver_trips"
  ADD CONSTRAINT "driver_trips_position_session_same_tenant"
    FOREIGN KEY ("organizationId", "positionSessionId")
    REFERENCES "position_sessions" ("organizationId", "id") ON DELETE SET NULL;

CREATE INDEX "driver_trips_organizationId_positionSessionId_idx"
  ON "driver_trips" ("organizationId", "positionSessionId");

-- ===========================================================================
-- 4. WORKER SESSIONS MAY CARRY A DRIVER IDENTITY
-- ===========================================================================
-- A worker who moves onto a driving position needs the driver portal. Rather than issuing a
-- second session or inventing a fourth actor type, the worker's own session gains the driver
-- profile linked to them plus the driver permission set, for exactly as long as the driving
-- position session is open.
--
-- The rule that does NOT relax: a session still never carries both a user and a worker/driver
-- identity, and a worker session still never carries a userId.

ALTER TABLE "sessions" DROP CONSTRAINT "sessions_actor_matches_type";

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_actor_matches_type"
    CHECK (
      ("actorType" = 'USER'   AND "userId"   IS NOT NULL AND "workerId" IS NULL AND "driverId" IS NULL)
   OR ("actorType" = 'WORKER' AND "workerId" IS NOT NULL AND "userId"   IS NULL)
   OR ("actorType" = 'DRIVER' AND "driverId" IS NOT NULL AND "userId"   IS NULL AND "workerId" IS NULL)
    );

-- A worker session's driver identity must be the driver profile actually linked to that worker.
-- Enforced in the application; recorded here as the intent for anyone reading the schema, since
-- expressing it in SQL would need a trigger and a trigger is a worse place for a business rule.
COMMENT ON COLUMN "sessions"."driverId" IS
  'For DRIVER sessions, the authenticated driver. For WORKER sessions, the driver profile linked to that worker, set only while a DRIVING position session is open.';
