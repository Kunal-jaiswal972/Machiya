-- Runs at the very end of initdb (the "zz-" prefix orders it after the image's
-- own scripts).
--
-- postgis/postgis installs postgis, postgis_topology, fuzzystrmatch and
-- postgis_tiger_geocoder into the application database automatically. Prisma
-- Migrate then compares the database against its (empty) migration history,
-- sees four extensions it never created, calls it drift, and demands a full
-- `migrate reset` before the first migration can be written.
--
-- Dropping them here hands the extension set to packages/db/prisma, which
-- declares exactly the two the app needs (postgis, pg_trgm) and creates them in
-- the init migration. The binaries stay in the image either way, so the postgis
-- healthcheck — which asserts availability, not installation — still passes.
DROP EXTENSION IF EXISTS postgis_tiger_geocoder CASCADE;
DROP EXTENSION IF EXISTS postgis_topology CASCADE;
DROP EXTENSION IF EXISTS fuzzystrmatch CASCADE;
DROP EXTENSION IF EXISTS postgis CASCADE;

DROP SCHEMA IF EXISTS tiger_data CASCADE;
DROP SCHEMA IF EXISTS tiger CASCADE;
DROP SCHEMA IF EXISTS topology CASCADE;
