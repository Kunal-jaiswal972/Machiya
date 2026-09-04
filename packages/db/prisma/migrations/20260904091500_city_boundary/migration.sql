-- `City.boundary`: the administrative polygon a listing is assigned to by
-- containment rather than by nearest centroid. See DECISIONS.md D50.
--
-- Declared OPTIONAL in schema.prisma for the same reason every geography column
-- in this schema is: a REQUIRED `Unsupported()` field makes Prisma drop the
-- model's `create` operation entirely (D15). Prisma cannot SELECT it either, so
-- every read goes through packages/db/src/geo-queries.ts.
ALTER TABLE "City" ADD COLUMN "boundary" geography(MultiPolygon, 4326);

-- The CHECK enforces WELL-FORMEDNESS, not presence, and that is a decision
-- rather than an omission (D50):
--
--   * a NOT NULL boundary would make `pnpm db:seed` fail on a clone that has
--     never run `pnpm bootstrap`, because the polygons are derived from the
--     local Nominatim. The core stack has to be usable before the geo profile
--     exists (D6), so breaking the seed to catch a missing polygon trades a
--     loud failure for a much more common one.
--   * presence is enforced where it can be enforced without that cost:
--     `pnpm cities:validate` warns per city, and `/health/geo` reports the
--     artifact state.
--
-- What this constraint catches is the failure that is otherwise SILENT: a
-- boundary with no area. `MULTIPOLYGON EMPTY` and a ring whose points are
-- collinear are both accepted by PostGIS, both store happily, and both then
-- match nothing — so every listing in that city falls through to the
-- nearest-centroid guess while the column looks populated.
--
-- Note what is deliberately NOT checked: ring point counts. PostGIS refuses a
-- ring with fewer than four points at parse time, so a constraint on
-- ST_NPoints can never fire, and a constraint that cannot fire is worse than
-- none — it reads as protection.
ALTER TABLE "City" ADD CONSTRAINT "city_boundary_has_area"
  CHECK ("boundary" IS NULL OR ST_Area("boundary"::geometry) > 0);

-- CreateIndex
CREATE INDEX "city_boundary_gix" ON "City" USING GIST ("boundary");
