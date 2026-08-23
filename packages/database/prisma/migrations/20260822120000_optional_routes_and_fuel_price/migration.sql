-- ---------------------------------------------------------------------------
-- Optional routes, and a fuel price to cost them against.
--
-- Two small columns, both in service of the same rule: a trip must be recordable without any
-- planning at all, and must be measurable when planning exists.
--
--   * `driver_trips.plannedDistanceMeters` — the distance a declared route was expected to
--     cover. Null for the common case: the driver got in and drove.
--   * `organization_settings.fuelPricePerLiter` — what a litre costs this organization. Null
--     until someone enters one; the screens then show litres and no money, rather than a cost
--     derived from a number nobody supplied.
--
-- HAND-WRITTEN, like every migration in this directory. `prisma migrate dev` cannot see the
-- composite `*_same_tenant` foreign keys or the partial unique indexes from the invariants
-- migration and would propose dropping them. `tests/integration/schema-invariants.test.ts`
-- fails the build if they ever actually disappear.
-- ---------------------------------------------------------------------------

ALTER TABLE "driver_trips"
  ADD COLUMN "plannedDistanceMeters" INTEGER;

-- A planned distance is a distance. Zero would mean "planned to go nowhere", which is not a
-- plan, and a negative one is a bug arriving as data.
ALTER TABLE "driver_trips"
  ADD CONSTRAINT "driver_trips_planned_distance_positive"
    CHECK ("plannedDistanceMeters" IS NULL OR "plannedDistanceMeters" > 0);

ALTER TABLE "organization_settings"
  ADD COLUMN "fuelPricePerLiter" DECIMAL(10, 4);

ALTER TABLE "organization_settings"
  ADD CONSTRAINT "organization_settings_fuel_price_positive"
    CHECK ("fuelPricePerLiter" IS NULL OR "fuelPricePerLiter" > 0);
