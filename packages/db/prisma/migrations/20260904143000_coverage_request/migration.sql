-- CreateTable
CREATE TABLE "CoverageRequest" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "location" geography(Point, 4326),
    "placeLabel" TEXT,
    "asks" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoverageRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoverageRequest_createdAt_idx" ON "CoverageRequest"("createdAt");

-- CreateIndex
CREATE INDEX "coverage_request_location_gix" ON "CoverageRequest" USING GIST ("location");

-- CreateIndex
CREATE UNIQUE INDEX "CoverageRequest_email_lat_lng_key" ON "CoverageRequest"("email", "lat", "lng");

-- Hand-appended. `CoverageRequest` carries the same lat/lng-to-geography
-- invariant as every other geo model, and neither the trigger nor the CHECK is
-- expressible in schema.prisma. See DECISIONS.md D2 and D15.
--
-- Why a geography column on a table nothing routes from: the question this
-- table exists to answer is "which city should be next", and that is a spatial
-- clustering question. Forty requests spread over Maharashtra are not the same
-- signal as forty within 20 km of Nariman Point, and without the column the
-- second query is a full scan plus arithmetic in JavaScript.

DROP TRIGGER IF EXISTS coverage_request_sync_location ON "CoverageRequest";
CREATE TRIGGER coverage_request_sync_location
  BEFORE INSERT OR UPDATE OF lat, lng ON "CoverageRequest"
  FOR EACH ROW
  EXECUTE FUNCTION machiya_sync_location();

UPDATE "CoverageRequest" SET lat = lat WHERE location IS NULL;

ALTER TABLE "CoverageRequest" DROP CONSTRAINT IF EXISTS coverage_request_location_present;
ALTER TABLE "CoverageRequest"
  ADD CONSTRAINT coverage_request_location_present CHECK ("location" IS NOT NULL);
