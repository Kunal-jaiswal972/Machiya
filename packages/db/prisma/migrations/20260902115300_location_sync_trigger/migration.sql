-- Hand-authored. Three things here cannot be expressed in schema.prisma: a
-- trigger, a CHECK constraint, and a partial index. All three are load-bearing.
--
-- DECISIONS.md D2  — why the lat/lng-to-geography invariant lives in the database
-- DECISIONS.md D13 — why the plain GiST indexes are NOT in this file
-- DECISIONS.md D15 — why NOT NULL is a CHECK rather than a column constraint

-- ---------------------------------------------------------------------------
-- 1. Derive `location` from lat/lng on every write, from every client.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION machiya_sync_location() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.lat IS NULL OR NEW.lng IS NULL THEN
    RAISE EXCEPTION 'lat and lng are both required to derive location';
  END IF;

  IF NEW.lat < -90 OR NEW.lat > 90 THEN
    RAISE EXCEPTION 'lat out of range: %', NEW.lat;
  END IF;

  IF NEW.lng < -180 OR NEW.lng > 180 THEN
    RAISE EXCEPTION 'lng out of range: %', NEW.lng;
  END IF;

  -- Argument order matters: ST_MakePoint takes (x, y) — longitude first.
  NEW.location := ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326)::geography;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION machiya_sync_location() IS
  'Derives the geography(Point,4326) location column from the lat/lng floats. Attached BEFORE INSERT OR UPDATE OF lat, lng on every geo table.';

DROP TRIGGER IF EXISTS listing_sync_location ON "Listing";
CREATE TRIGGER listing_sync_location
  BEFORE INSERT OR UPDATE OF lat, lng ON "Listing"
  FOR EACH ROW
  EXECUTE FUNCTION machiya_sync_location();

DROP TRIGGER IF EXISTS office_location_sync_location ON "OfficeLocation";
CREATE TRIGGER office_location_sync_location
  BEFORE INSERT OR UPDATE OF lat, lng ON "OfficeLocation"
  FOR EACH ROW
  EXECUTE FUNCTION machiya_sync_location();

-- Backfill anything written before the trigger existed. A no-op on a fresh
-- database, and what makes this migration safe to apply to an existing one.
UPDATE "Listing" SET lat = lat WHERE location IS NULL;
UPDATE "OfficeLocation" SET lat = lat WHERE location IS NULL;

-- ---------------------------------------------------------------------------
-- 2. `location` is nullable in schema.prisma only because a required
--    Unsupported() field removes Prisma's create operation. Enforce the real
--    invariant here. Prisma has no CHECK support, so it ignores this and no
--    drift is reported.
-- ---------------------------------------------------------------------------

ALTER TABLE "Listing" DROP CONSTRAINT IF EXISTS listing_location_present;
ALTER TABLE "Listing"
  ADD CONSTRAINT listing_location_present CHECK ("location" IS NOT NULL);

ALTER TABLE "OfficeLocation" DROP CONSTRAINT IF EXISTS office_location_present;
ALTER TABLE "OfficeLocation"
  ADD CONSTRAINT office_location_present CHECK ("location" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 3. Every radius search filters on PUBLISHED, so give that path its own
--    smaller index rather than making it walk drafts, paused and rented rows.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS listing_location_published_gix
  ON "Listing" USING GIST ("location")
  WHERE "status" = 'PUBLISHED';
