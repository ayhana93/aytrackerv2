-- ---------------------------------------------------------------------------
-- Organization logos: the gallery an admin picks the company logo from.
--
-- HAND-WRITTEN, deliberately. `prisma migrate dev` cannot see the composite `*_same_tenant`
-- foreign keys or the partial unique indexes from the invariants migration and proposes dropping
-- all of them; any migration touching these tables must be written by hand. See the note at the
-- top of `20260820094500_driving_positions`.
--
-- The bytes live in Postgres rather than in a bucket. docs/white-label.md § 4 says the opposite
-- and this is the exception it now records: there is no object storage in this deployment, and a
-- file written to a container filesystem is gone on the next deploy. The cost the rule was aimed
-- at — blobs bloating a table every query reads — is avoided by giving them a table of their own
-- that nothing but the image route ever selects from.
-- ---------------------------------------------------------------------------

CREATE TABLE "organization_logos" (
  "id"               TEXT NOT NULL,
  "organizationId"   TEXT NOT NULL,
  "fileName"         TEXT NOT NULL,
  "contentType"      TEXT NOT NULL,
  "byteSize"         INTEGER NOT NULL,
  "checksum"         TEXT NOT NULL,
  "data"             BYTEA NOT NULL,
  "uploadedByUserId" TEXT,
  "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "organization_logos_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "organization_logos"
  ADD CONSTRAINT "organization_logos_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "organization_logos_uploadedByUserId_fkey"
    FOREIGN KEY ("uploadedByUserId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One row per distinct file per organization: re-uploading the same logo selects the asset that
-- is already there rather than adding a second copy of it to the gallery.
CREATE UNIQUE INDEX "organization_logos_organizationId_checksum_key"
  ON "organization_logos" ("organizationId", "checksum");

CREATE INDEX "organization_logos_organizationId_createdAt_idx"
  ON "organization_logos" ("organizationId", "createdAt");

-- The tenant key every composite `*_same_tenant` foreign key points at.
ALTER TABLE "organization_logos"
  ADD CONSTRAINT "organization_logos_tenant_key" UNIQUE ("organizationId", "id");

-- A logo is capped at 512 KiB by the upload route. Repeating it here means an import, a backfill
-- or a future admin tool cannot put a 40 MB PNG on somebody's login page.
ALTER TABLE "organization_logos"
  ADD CONSTRAINT "organization_logos_size_matches_data"
    CHECK ("byteSize" = octet_length("data")),
  ADD CONSTRAINT "organization_logos_size_bounded"
    CHECK ("byteSize" > 0 AND "byteSize" <= 524288);

-- ---------------------------------------------------------------------------
-- The chosen logo.
-- ---------------------------------------------------------------------------

ALTER TABLE "organization_branding"
  ADD COLUMN "logoAssetId" TEXT;

ALTER TABLE "organization_branding"
  ADD CONSTRAINT "organization_branding_logoAssetId_fkey"
    FOREIGN KEY ("logoAssetId") REFERENCES "organization_logos" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  -- An organization cannot select another tenant's asset, structurally rather than by review.
  ADD CONSTRAINT "organization_branding_logo_same_tenant"
    FOREIGN KEY ("organizationId", "logoAssetId") REFERENCES "organization_logos" ("organizationId", "id") ON DELETE SET NULL;

CREATE INDEX "organization_branding_logoAssetId_idx"
  ON "organization_branding" ("logoAssetId");

-- ---------------------------------------------------------------------------
-- Row Level Security, on the same terms as every other tenant table.
-- ---------------------------------------------------------------------------

ALTER TABLE "organization_logos" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "organization_logos_tenant_isolation" ON "organization_logos"
  USING ("organizationId" = aytracker_current_org())
  WITH CHECK ("organizationId" = aytracker_current_org());
