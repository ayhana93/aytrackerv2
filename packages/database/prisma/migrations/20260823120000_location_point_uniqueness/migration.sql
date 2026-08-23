-- One fix per session per instant.
--
-- `POST /tracking/points` is deliberately not wrapped in the idempotency ledger — a row per batch
-- would double the write volume of the busiest endpoint in the system — and the comment on that
-- endpoint says appending the same point twice is prevented by ordering and the session window.
-- It was not. The device queue removes a point only once the server has acknowledged it, so a
-- response lost to a dropped connection leaves the whole batch queued and it is sent again. Every
-- point in it then has a timestamp at or before the newest stored one, which puts it in the
-- offline-replay bucket, and that bucket is thinned only against itself — so the batch was stored
-- a second time.
--
-- The arithmetic survived this: a segment between two fixes stamped at the same instant has zero
-- elapsed time and is skipped, so distance, stops and gaps were never wrong. What grew was the
-- highest-frequency table in the product, without bound, in proportion to how bad a driver's
-- signal is — which is exactly backwards.
--
-- The unique index is the guarantee; `createMany({ skipDuplicates: true })` is what turns it into
-- a quiet no-op rather than a failed upload for a driver whose connection is already poor.

-- Any duplicates already stored. `id` is uuid v7, so the smallest is the one that arrived first.
DELETE FROM "location_points" AS later
      USING "location_points" AS first
      WHERE later."organizationId"    = first."organizationId"
        AND later."trackingSessionId" = first."trackingSessionId"
        AND later."timestamp"         = first."timestamp"
        AND later."id"                > first."id";

-- Replaces the plain index of the same shape rather than joining it: two indexes on the same
-- three columns would double the write cost of every ingested point to buy nothing.
DROP INDEX IF EXISTS "location_points_organizationId_trackingSessionId_timestamp_idx";

CREATE UNIQUE INDEX "location_points_session_instant_key"
    ON "location_points" ("organizationId", "trackingSessionId", "timestamp");
