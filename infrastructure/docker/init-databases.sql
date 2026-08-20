-- Runs once, on first boot of an empty postgres volume.
--
-- The application database is created by POSTGRES_DB. This adds the two the workflow needs
-- beyond it:
--
--   aytracker_test    integration tests truncate and re-seed constantly; pointing them at the
--                     development database would delete a developer's demo data every run.
--   aytracker_shadow  Prisma's shadow database for `migrate dev`. Without it Prisma tries to
--                     create one itself, which needs CREATEDB and fails on managed hosts.

CREATE DATABASE aytracker_test OWNER aytracker;
CREATE DATABASE aytracker_shadow OWNER aytracker;
