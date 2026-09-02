# Decisions

One entry per non-obvious choice, newest section last. Each records what was
chosen and why, so the reasoning survives past the commit that made it.

## Step 1 — monorepo scaffold

### D1. Postgres + PostGIS, not MongoDB

Prisma's MongoDB connector has no geospatial support, so radius search would
have to go through untyped raw BSON commands. The domain (users, listings,
enquiries, favorites, saved searches) is relational anyway.

### D2. lat/lng is kept in sync with `location` by a Postgres trigger

Prisma cannot SELECT an `Unsupported("geography(Point, 4326)")` column, so every
geo model stores `lat`/`lng` Floats for reading and a `location` geography column
for indexing and querying. The two must never disagree.

**Chosen: a `BEFORE INSERT OR UPDATE` trigger deriving `location` from
`lat`/`lng`.** The alternative — a Prisma transaction that inserts the row then
issues a raw `UPDATE ... SET location = ST_MakePoint(...)` — puts the invariant in
application code, which means every future write path (seed script, admin tools,
a manual `psql` fix, a bulk import) has to remember it. A trigger makes the
invariant impossible to skip and keeps writes to a single statement. Cost: the
rule lives in a hand-written migration rather than in `schema.prisma`, so it is
documented here and in a comment at the top of the schema.

### D3. Prisma generator is `prisma-client`, output to `packages/db/generated/prisma`

The legacy `prisma-client-js` generator writes CommonJS into `node_modules` and
is awkward to import from a pure-ESM package. The `prisma-client` generator is
ESM-native, requires an explicit output path, and is the shape Prisma 7 makes
mandatory — so this also removes work from the eventual v7 upgrade.

### D4. All Prisma CLI commands run from the repo root

`packages/db` owns the schema, the client, and (from step 2) every line of raw
SQL. But the CLI is invoked from the root via `pnpm db:*` scripts with an
explicit `--schema` path, so the root `.env` is the single source of environment
truth. Running the CLI inside `packages/db` would make it look for a second
`.env` there and silently diverge from what the apps use.

### D5. Spec-named major versions are honoured even where a newer major exists

The brief pins react-router v7, Prisma 6, and ESLint 9. At scaffold time
react-router 8, Prisma 7, and ESLint 10 were all released. The pins were kept:
the brief is the contract, and a mid-scaffold major bump costs more than the new
features are worth right now. Upgrade path, when it is wanted: react-router 8
drops the `react-router-dom` shim (already unused here — imports come from
`react-router` and `react-router/dom`), and Prisma 7 requires exactly the
generator shape chosen in D3.

Related: Vite 7 rather than 8, because `@vitejs/plugin-react` 6 (the version Vite
8 requires) pulls in oxc/rolldown peers that are churning. TypeScript 5.9 rather
than 7, because `typescript-eslint` 8 targets the 5.x compiler.

### D6. Geo services sit behind a compose `geo` profile

Photon and OSRM cannot start until `scripts/bootstrap.sh` has produced the merged
three-city OSM extract and built their indexes. Leaving them in the default
profile would make a fresh `docker compose up` fail on a clean clone. So:
`docker compose up -d` brings up the core stack, `docker compose --profile geo up -d`
adds routing and geocoding once the artifacts exist.

### D7. `node:22-bookworm-slim`, not Alpine, for the API and worker images

Prisma's query engine ships glibc binaries by default; Alpine needs explicit
`binaryTargets = ["linux-musl-openssl-3.0.x"]` plus `libc6-compat`, which is a
recurring source of "works locally, broken in Docker". The size difference does
not justify the failure mode. The web image is a different story — it is static
files behind `nginx:alpine`.

### D8. The postgis healthcheck is a script, not an inline shell string

`scripts/postgis-healthcheck.sh` runs `pg_isready` **and** asserts the PostGIS
extension is available, per the brief. It lives in a file because the equivalent
inline `CMD-SHELL` string needs nested quoting that is unreadable and easy to
break. `.gitattributes` forces LF on `*.sh` so it stays executable in a container
when checked out on Windows.

### D9. `@machiya/shared` is consumed as built `dist`, not as source

`exports` points at `dist/`, so the Node apps run plain compiled JavaScript and
`pnpm deploy --prod` can collapse the workspace into a self-contained image.
The cost is that `pnpm dev` needs the packages built once first — handled by the
root `predev`/`build:packages` scripts.

### D10. `/health` answers 503 when a dependency is down

The body always reports per-dependency detail, but the status code changes, so
Docker, a load balancer, and a human reading the JSON all get the same verdict.
`/health/live` is the liveness-only counterpart and never touches a dependency.

### D11. `minio/mc:latest` is the one unpinned image

Every other image is pinned to an exact tag. The `minio-init` container only
creates a bucket and exits, and `mc` release tags move faster than they are worth
tracking. Revisit if bucket setup ever becomes load-bearing.

### D12. maplibre-gl's worker is copied into `public/` and set with `setWorkerUrl()`

maplibre-gl 6 resolves its tile-parsing worker at runtime from its own module URL
(`new URL('./maplibre-gl-worker.mjs', import.meta.url)`). Two things break that in
a Vite app, and both fail **silently** — style, sprite and TileJSON all load, no
error event fires, and the map paints its background layer and nothing else:

- in dev, the dependency optimizer rewrites maplibre's entry but drops the worker
  chunk, so the worker 404s. Fixed with `optimizeDeps.exclude: ['maplibre-gl']`.
- in a production build, Rollup inlines maplibre into a hashed chunk, so
  `import.meta.url` points at `/assets/`, where the worker does not exist.
  maplibre then falls back to `new Worker('')`, which is why there is no error.

Fix: `apps/web/scripts/sync-maplibre-worker.mjs` copies `maplibre-gl-worker.mjs`
and its sibling `maplibre-gl-shared.mjs` into `public/maplibre/` before every dev
run and build, and `src/lib/maplibre-setup.ts` calls the library's own
`setWorkerUrl()`. nginx also needs `.mjs` served as `text/javascript`, or the
browser refuses to start a module worker.

`build.rollupOptions.output.manualChunks` must NOT be used to isolate maplibre —
that reintroduces the same break. The 1 MB chunk-size warning is suppressed with
`chunkSizeWarningLimit` instead.

## Step 2 — packages/db

### D13. The GiST indexes live in `schema.prisma`, not in a hand-written migration

The brief says Prisma will not generate spatial indexes. That is no longer true:
Prisma 6.19 accepts `@@index([location], type: Gist)` on an `Unsupported()`
field, and emits `CREATE INDEX ... USING GIST` in the generated migration.

Leaving them hand-written was actively worse. Prisma introspects these indexes,
so every subsequent `prisma migrate dev` produced a migration that DROPPED them
— a trap that would eventually be applied by someone not reading the diff. They
are declared in the schema with `map:` pinning the brief's names
(`listing_location_gix`, `office_location_gix`), which keeps the names and
removes the drift.

Only what Prisma genuinely cannot express is hand-written: the trigger, the CHECK
constraint, and the partial index.

### D14. `@machiya/shared` owns the Zod enums; `packages/db` proves they match

The brief asks for shared Zod schemas "derived from Prisma types". Deriving them
in `shared` would mean `shared` importing `@machiya/db`, which already imports
`shared` — a cycle.

So the values are written once in `packages/shared/src/enums.ts`, and
`packages/db/src/enum-guard.ts` holds a type-level `Exact<A, B>` assertion per
enum against the generated Prisma types. Add a variant to one side only and
`pnpm typecheck` fails on that file, naming the enum. One source of truth for
validation, no cycle, and the duplication cannot rot in silence.

### D15. `location` is optional in the schema; NOT NULL is a CHECK constraint

Declaring `location Unsupported("geography(Point, 4326)")` as REQUIRED makes
Prisma drop the model's `create` operation entirely — `prisma.listing.create()`
fails at runtime with "Operation 'createOne' for model 'Listing' does not match
any query". That leaves no way to write a listing through the client at all.

The column is therefore optional in `schema.prisma` and the real invariant is a
CHECK constraint (`listing_location_present`, `office_location_present`) added in
the hand-written migration. Prisma has no CHECK support, so it ignores them and
reports no drift. Between the BEFORE trigger and the CHECK, a listing with a null
location cannot exist — and a test proves the constraint fires when the column is
nulled behind the trigger's back.

### D16. An initdb script hands the extension set to Prisma

`postgis/postgis:16-3.4` installs `postgis`, `postgis_topology`,
`fuzzystrmatch` and `postgis_tiger_geocoder` into the application database
automatically. Prisma then compares the database against its migration history,
finds four extensions it never created, calls it drift, and demands a full
`migrate reset` before the first migration can be written — on a completely
fresh clone.

`scripts/postgres-init/zz-prisma-owns-extensions.sql`, mounted into
`/docker-entrypoint-initdb.d`, drops them at the end of initdb. The schema then
declares exactly the two the app needs and creates them in the init migration.
The binaries remain in the image, so the healthcheck — which asserts
availability, not installation — is unaffected.

Note the mount is the file, not the directory: the Postgres entrypoint only
executes scripts sitting directly in `/docker-entrypoint-initdb.d`.

### D17. Money is `Int` rupees, except fuel prices

`rentAmount`, `salePrice`, `securityDeposit` and `maintenanceMonthly` are `Int`
holding whole rupees. No sub-rupee rent exists in this market, and Int keeps the
money out of `Decimal` serialisation — which otherwise leaks a Decimal instance
into every JSON response and every arithmetic expression in the commute-cost
engine.

`FuelPrice.price` is the exception: `Decimal(8, 2)`, because petrol is quoted to
the paisa and a rounded fuel price would visibly skew a monthly commute cost.

### D18. Similar-listing KNN is bounded by `ST_DWithin`

`ORDER BY location <-> subject` alone has no notion of "too far": once local
matches run out, a listing in another city 1,500 km away is a perfectly good
nearest neighbour, and a test caught exactly that. `findSimilarListings` takes a
`maxDistanceMeters` bound (default 10 km) applied with `ST_DWithin` before the
KNN ordering, so the operator still drives an index-assisted scan.

### D19. Search sorting uses row-constructor keyset pagination, not OFFSET

Cursors carry `(sortKey, id)` base64url-encoded. The secondary sort column always
runs in the same direction as the primary so the row-constructor comparison
`("sortKey", "id") < (v, id)` stays correct for descending sorts. `OFFSET` would
skip or repeat rows while listings are being published underneath a paging user,
and gets slower with every page.

Sort direction and comparison operator are the only things reaching SQL through
`Prisma.raw`, and both come from a closed `switch` in `sortPlan()`. Every value —
coordinates included — is a bound parameter.

## Step 3 — Better Auth

### D20. `session.storeSessionInDatabase` is on, because secondaryStorage alone moves sessions out of Postgres

Providing `secondaryStorage` (Redis) makes Better Auth store sessions in Redis
**only** — and the Better Auth CLI then generates no `Session` model at all,
which is how this was noticed. That would mean a Redis restart signs everybody
out and no session is auditable or revocable from the database.

`storeSessionInDatabase: true` keeps the row in Postgres while reads still come
from Redis, which is what "database-backed sessions with cookie caching for read
speed" actually requires. Verified: after a sign-in, `SELECT count(*) FROM
"Session"` returns the row, and sign-out removes it.

### D21. Two Redis connections, with opposite failure policies

`apps/api/src/lib/redis.ts` exports two clients:

- `redis` (cache: POIs, routes, geocodes, fuel prices) — `lazyConnect`, no
  offline queue. A command issued while Redis is unreachable rejects
  immediately, and every caller has a Postgres fallback or serves a degraded
  result. Never block a request on a cache.
- `authRedis` (sessions, rate-limit counters) — eager connect, offline queue on.
  There is no fallback on the credential path.

This was not theoretical: with the cache client's settings, the rate limiter's
first `INCR` — issued before anything had triggered a connect — threw
`Stream isn't writeable and enableOfflineQueue options is false` and turned every
single sign-up into a 500.

### D22. The Better Auth schema is checked against the runtime, not the CLI

`@better-auth/cli`'s newest published release is 1.4.22 while `better-auth` is
1.7.2. The CLI generated an `Account` model with no `issuer` column, which the
1.7 adapter writes — so every sign-up failed at runtime with
`Unknown argument 'issuer'`, with nothing at build time to catch it.

`pnpm auth:check` (`apps/api/scripts/check-auth-schema.ts`) calls
`getAuthTables(auth.options)` — the same definitions the adapter writes through —
and diffs them against `schema.prisma`, listing any missing column. It runs in
CI. Run it after every Better Auth upgrade or plugin change; `pnpm auth:generate`
is still the starting point, but its output is a draft, not the truth.

The CLI's `@@map` directives are also removed, so table names stay PascalCase
like the rest of the schema. The Prisma adapter resolves models by Prisma model
name, so this changes nothing at runtime.

### D23. Route names are verified, not assumed

Better Auth 1.7 renamed `/forget-password` to `/request-password-reset`. The old
name in `rateLimit.customRules` matched nothing and silently left the endpoint on
the default limit — a rate-limit rule that quietly does nothing is worse than no
rule, because it reads as covered. `pnpm auth:routes` prints the live route list
from the openAPI plugin; check custom rules against it after an upgrade.

### D24. The verification email's callback is rebuilt to point at the web app

`sendVerificationEmail` receives a `url` whose `callbackURL` defaults to the
API's own `baseURL`, so a verified user landed on `http://localhost:4000/` — a
bare JSON host — instead of the app. The handler must stay on the API because it
consumes the token, so the URL is rebuilt with `callbackURL` set to
`WEB_APP_URL`, keeping `url` as the fallback if the callback shape changes.

### D25. Guards take an injected session resolver

`requireAuth(resolve)` is a factory over a `SessionResolver`, not a module that
imports the auth instance. Two reasons: the guard tests need no cookies,
database, Redis or auth provider — they inject a fake resolver and assert on
status codes — and swapping the auth provider touches
`apps/api/src/auth/session.ts` alone.

`resolveSession` re-parses the role through the shared Zod enum rather than
casting it. An unrecognised role fails closed, with a log line naming the user,
instead of sliding through a `requireRole` check.

## Step 4 — bootstrap and seed

### D26. Geocoding is self-hosted Nominatim, not Photon

The brief specifies "self-hosted Photon (komoot/photon Docker image) indexed
from the merged three-city OSM extract". Two things make that impossible as
written, both verified rather than assumed:

1. **Photon cannot read an `.osm.pbf`.** Its only import paths are
   `-nominatim-host` (a live Nominatim database) or `-import-file` (a Photon JSON
   dump). Indexing "from the merged extract" therefore requires standing up
   Nominatim first regardless.
2. **There is no `ghcr.io/komoot/photon` image.** komoot publishes the jar only;
   `docker manifest inspect` on that reference fails. The compose file had been
   written against it and would have failed on first `--profile geo up`.

The prebuilt-index escape hatch is also gone: the per-country downloads
(`.../by-country-code/in/photon-db-in-latest.tar.bz2`) 404, and only the full
planet index remains — 101 GB.

So: **self-hosted Nominatim (`mediagis/nominatim:5.3`) is the primary geocoder.**
It imports the merged extract directly, serves `/search` and `/reverse`, is free
and self-hostable, and it is the provider the brief already nominated as the
fallback — so the `GeocodeProvider` adapter shape does not change, only which URL
is primary. Photon remains available as a type-ahead layer on top of that same
database, behind its own `--profile photon` (unofficial `rtuszik/photon-docker`
image), for when autocomplete latency actually matters.

### D27. Geofabrik publishes India by zone, not by state

The brief says "Geofabrik only publishes India per-state". It does not — the
sub-regions are six zones (central, eastern, north-eastern, northern, southern,
western), and the per-state URLs the brief implies return an HTML error page
rather than a `.pbf`, which is the kind of thing that fails as a corrupt download
much later.

`scripts/cities.ts` therefore maps each city to its zone: Patna to
`eastern-zone` (236 MB), Bengaluru to `southern-zone` (533 MB), Pune to
`western-zone` (210 MB). Roughly 1 GB downloaded once and cached; the bbox cuts
that follow are a few MB each.

### D28. Every bootstrap tool runs in a container

`osmium` (`iboates/osmium:1.19.0`), OSRM and Nominatim all run through Docker, so
`scripts/bootstrap.sh` needs nothing on the host but `docker`, `curl` and `pnpm`.
On Windows the mount paths go through `cygpath -m` and `MSYS_NO_PATHCONV=1`,
because Docker Desktop wants `C:/...` and Git Bash would otherwise rewrite
`/cache` into a host path.

The OSRM graph build is not duplicated in the script: it delegates to the
`osrm-init` compose service, so the pipeline is defined once and
`docker compose --profile geo up` rebuilds it the same way.

### D29. The seed prunes listings it no longer plans

Upsert-on-slug alone is not idempotent across a change to the _plan_. Re-seeding
after adjusting how listings are laid out changed their slugs, so the new rows
were inserted while the old ones stayed behind: 51 listings silently became 90.

Everything the seed creates is owned by `lister@dev.local`, so `seedListings`
finishes by deleting any listing of theirs whose slug is not in the current plan.
Cascades take the images, amenities, enquiries and favourites with it. Verified:
two consecutive runs both end at exactly 51 listings.

Determinism comes from a fixed-seed mulberry32 PRNG, so the same listings land at
the same coordinates with the same prices on every machine — which is what makes
screenshots and bug reports comparable.

### D30. Listings cluster on the office localities, two thirds to one third

Spreading 17 listings evenly across six localities 5-20 km apart left only three
to seven inside a 3 km office radius — the one view the entire product is built
around. So ~65% cluster on the first two localities (where `seedUsers` places
each dev office) and the rest spread across the others: dense enough that the
ring view, the filters and the sort orders all have something to work on, while
the wider city still has listings for a different office.

### D31. Fixture images are uploaded once and shared

`scripts/generate-fixtures.ts` renders eight gradient JPEGs (~11 KB each, 89 KB
total) which are committed. The seed uploads them to `fixtures/<name>.jpg` in
MinIO and every listing's `ListingImage` rows reference those shared keys.

Uploading a private copy per listing would mean ~200 objects of identical bytes:
the object key is what the gallery code exercises, not the pixels. Real uploads
get their own keys in step 5. The images are deliberately plain — labelled
"Machiya seed data" — so a placeholder is never mistaken for a real photo.

### D32. Dev account passwords are hashed by Better Auth's own hasher

`prisma/seed.ts` imports `hashPassword` from `better-auth/crypto` rather than
hand-rolling scrypt. If the library changes its hash format, the seeded accounts
change with it instead of silently failing to sign in. Verified: all three dev
accounts sign in and `/api/me` reports the right role and verified state.
