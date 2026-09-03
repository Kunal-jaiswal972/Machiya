-- CreateTable
CREATE TABLE "Locality" (
    "id" TEXT NOT NULL,
    "cityId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "location" geography(Point, 4326),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Locality_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Locality_cityId_idx" ON "Locality"("cityId");

-- CreateIndex
CREATE INDEX "Locality_name_idx" ON "Locality" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "locality_location_gix" ON "Locality" USING GIST ("location");

-- CreateIndex
CREATE UNIQUE INDEX "Locality_cityId_slug_key" ON "Locality"("cityId", "slug");

-- CreateIndex
CREATE INDEX "City_name_idx" ON "City" USING GIN ("name" gin_trgm_ops);

-- AddForeignKey
ALTER TABLE "Locality" ADD CONSTRAINT "Locality_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-appended. Locality carries the same lat/lng-to-geography invariant as
-- Listing and OfficeLocation, and neither the trigger nor the CHECK is
-- expressible in schema.prisma. See DECISIONS.md D2 and D15.
--
-- The GIN trigram indexes above were NOT hand-written: Prisma emits them from
-- `@@index([name(ops: raw("gin_trgm_ops"))], type: Gin)`, the same way it emits
-- the GiST ones. See D13 for why keeping them in the schema matters.

DROP TRIGGER IF EXISTS locality_sync_location ON "Locality";
CREATE TRIGGER locality_sync_location
  BEFORE INSERT OR UPDATE OF lat, lng ON "Locality"
  FOR EACH ROW
  EXECUTE FUNCTION machiya_sync_location();

UPDATE "Locality" SET lat = lat WHERE location IS NULL;

ALTER TABLE "Locality" DROP CONSTRAINT IF EXISTS locality_location_present;
ALTER TABLE "Locality"
  ADD CONSTRAINT locality_location_present CHECK ("location" IS NOT NULL);
