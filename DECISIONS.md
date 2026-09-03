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
mandatory — which is why the v7 move in D5 needed no generator change at all.

### D4. All Prisma CLI commands run from the repo root

`packages/db` owns the schema, the client, and (from step 2) every line of raw
SQL. But the CLI is invoked from the root via `pnpm db:*` scripts with an
explicit `--schema` path, so the root `.env` is the single source of environment
truth. Running the CLI inside `packages/db` would make it look for a second
`.env` there and silently diverge from what the apps use.

### D5. Prisma 7, with the connection string in `prisma.config.ts`

Rewritten. The scaffold pinned Prisma 6 because the brief named it, and that pin
is now reversed: the toolchain is on **Prisma 7.10.0**. What forced it is that a
v7 CLI against a v6-shaped schema fails outright with "The datasource property
url is no longer supported in schema files" — there is no half-way state to sit
in, and pinning backwards to keep a v6 schema shape only defers the same move.

What v7 actually changes here, all of it verified by running the commands rather
than reading the changelog:

- **`datasource.url` is gone from the schema.** It lives in `prisma.config.ts` at
  the repo root, which also carries `schema` and `migrations.path`. `extensions`
  is gone too: the `postgresqlExtensions` preview feature was deprecated in
  September 2025 and removed in 7, so `postgis` and `pg_trgm` are created by the
  plain SQL already in the init migration. Verified: `prisma migrate status`
  reports "Database schema is up to date!" — dropping the declaration causes no
  drift, because without the feature Prisma does not track extensions at all.
- **Prisma no longer loads `.env`.** `prisma.config.ts` loads it with `dotenv`,
  resolved from the config file's own directory via `import.meta.url` rather than
  from the current one. `dotenv/config` alone would read `.env` relative to
  wherever the command was typed, which broke `pnpm -F @machiya/db build` the
  moment a package script invoked the CLI from its own folder.
- **There is no Rust query engine.** The connection comes from
  `@prisma/adapter-pg`, constructed in `packages/db/src/client.ts` from
  `process.env.DATABASE_URL` at client construction rather than baked in at
  generate time — which is what lets one generated client serve the compose
  database, a testcontainer and CI's service container.
- **The generated client is TypeScript only.** No engine binary is emitted any
  more, so `packages/db/scripts/copy-runtime.mjs` (which existed to carry the
  binary into `dist/`) is deleted; it was copying zero files. `tsc` compiles the
  generated sources as part of the package, which the tsconfig already allowed
  for.
- **`migrate reset` no longer seeds.** The root `db:reset` script therefore
  chains `pnpm db:seed` explicitly, so "reset" still means what a developer
  expects. `migrations.seed` in the config keeps `prisma db seed` working, and
  carries the `--env-file-if-exists=.env` flag for the same reason as above.
- **The CLI refuses `migrate reset` when it detects an AI agent** and requires a
  consent variable naming the user's own words. That is a feature, not an
  obstacle: it is recorded here so the next person is not surprised by it.

One behaviour change bit the tests rather than the build, which is the sort of
thing a pinned version hides: the driver adapter sends query parameters to
Postgres with different type inference than the Rust engine did, so
`s."price" * (1 - $n)` — with an Int column on the left — now infers `$n` as
`integer` and fails with `invalid input syntax for type integer: "0.25"`. The
fix is to say what the parameter is: `${priceBand}::double precision`. Every
other float that reaches raw SQL was already cast.

The rest of the brief's version pins stand, because nothing forced them:
react-router 7 (8 only drops the `react-router-dom` shim, already unused —
imports come from `react-router` and `react-router/dom`), ESLint 9, Vite 7 rather
than 8 because `@vitejs/plugin-react` 6 pulls in churning oxc/rolldown peers, and
TypeScript 5.9 because `typescript-eslint` 8 targets the 5.x compiler.

Also from this correction: **`pnpm typecheck` is a hard gate, and it now covers
the whole repo.** `tsconfig.tools.json` adds `prisma.config.ts` and `scripts/` to
the root `typecheck` script — root-level TypeScript that belonged to no workspace
package and was therefore the one part of the tree nothing checked.

### D6. Geo services sit behind a compose `geo` profile

Nominatim and OSRM cannot start until `scripts/bootstrap.sh` has produced the
merged three-city OSM extract and built their indexes. Leaving them in the
default profile would make a fresh `docker compose up` fail on a clean clone.
So: `docker compose up -d` brings up the core stack, and
`docker compose --profile geo up -d` adds routing and geocoding once the
artifacts exist. `osrm-init` now also refuses to start with a clear message when
the extract is absent, rather than dying inside `osrm-extract`.

### D7. `node:22-bookworm-slim`, not Alpine, for the API and worker images

Native dependencies here ship glibc prebuilds and fall back to a source build
on musl: that was Prisma's query engine at scaffold time, and since the Prisma 7
move (D5) removed the engine entirely it is `sharp`/libvips in the worker image
that carries the same constraint. Alpine turns both into "works locally, broken
in Docker", and the size difference does not justify the failure mode. The web
image is a different story — it is static files behind `nginx:alpine`.

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

### D26. Photon was evaluated and removed; geocoding is Nominatim plus a local trigram tier

Rewritten, and this reverses the earlier version of this entry. Photon is not
deferred behind a profile — it is gone, along with its service, its `photon`
profile, its `photon-data` volume, and `PHOTON_URL` from every env surface. A
service in the compose file that nothing ever starts is worse than no service at
all: it reads as a supported option and it is not.

Why it cannot work here, all of it checked rather than assumed:

1. **Photon cannot read an `.osm.pbf`.** Its only import paths are
   `-nominatim-host` (a live Nominatim database) or `-import-file` (a Photon JSON
   dump). Indexing "from the merged extract" therefore requires standing up
   Nominatim first regardless — so Photon would be a second copy of a database
   this project already runs.
2. **There is no `ghcr.io/komoot/photon` image.** komoot publishes the jar only;
   `docker manifest inspect` on that reference fails. The compose file had been
   written against it and would have failed on the first `--profile geo up`.
3. **The prebuilt-index escape hatch is gone.** The per-country downloads
   (`.../by-country-code/in/photon-db-in-latest.tar.bz2`) 404, and only the full
   planet index remains — 101 GB.

That leaves exactly one thing Photon would have bought: type-ahead latency. And
that is better served locally, without a JVM and a duplicated index — see D39.

So: **self-hosted Nominatim (`mediagis/nominatim:5.3`) is the geocoder.** It
imports the merged extract directly and serves `/search` and `/reverse`.
`GEOCODE_PROVIDER` exists with `nominatim` as its only value, so the adapter's
provider selection stays explicit and swappable instead of hardcoded — adding a
second provider means adding an enum value and an adapter, not rewriting the
call sites.

Two things about the Nominatim service were verified while removing Photon,
because both fail slowly and invisibly:

- the Postgres cluster inside the image is **16**
  (`docker run --rm --entrypoint sh mediagis/nominatim:5.3 -c 'ls -d
/var/lib/postgresql/*/main'`), so `nominatim-data:/var/lib/postgresql/16/main`
  really is the right mount. Mounted anywhere else, the volume holds nothing and
  the whole import repeats on every recreate.
- the `nominatim-flatnode` volume was mounted at `/nominatim/flatnode` while
  `FLATNODE_FILE` was never set, so it was inert — a knob that looked configured
  and was not. Deleted; three city extracts are nowhere near large enough to
  need a flatnode file.

The OSRM services were pinned to `platform: linux/amd64` at the same time.
`docker manifest inspect --verbose osrm/osrm-backend:v5.25.0` returns a single
manifest, not a manifest list, for `linux/amd64` — there is no arm64 variant, so
without the pin Docker Desktop on Apple silicon fails or silently emulates.
`OSRM_CAR_PORT` also moved off 5000, which is AirPlay Receiver on macOS, and the
bike healthcheck stopped using `/route/v1/bike/...`: `osrm-routed` ignores the
profile segment entirely — the graph it was given decides the profile — so that
URL implied a distinction that does not exist.

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

### D31. Seed photos are real photographs, from a committed manifest

Rewritten. The first version of this entry described eight committed gradient
JPEGs, "deliberately plain — labelled Machiya seed data — so a placeholder is
never mistaken for a real photo". That was the wrong trade. A product whose
entire argument is "look at these homes near your office" cannot be evaluated
against grey gradients: every screenshot looks broken, and no one can tell a
layout problem from a data problem.

So the seed uses **real house photographs**, without making `db:seed` depend on a
live network call. Three pieces:

1. **`scripts/fetch-seed-photos.ts`, run explicitly as `pnpm seed:photos`.** Not
   part of `db:seed`. It queries the Unsplash official API (free Demo tier, 50
   requests an hour) with `UNSPLASH_ACCESS_KEY` from the root `.env`, over a
   fixed set of terms with a fixed count per term — apartment interior, living
   room, indian house exterior, bedroom, kitchen, balcony, apartment building.
   23 photos.
2. **`scripts/fixtures/photos.json`, committed.** Photo ids, pinned download
   URLs, dimensions, photographer name and profile link. **This is the
   deterministic artifact**, not the images. With a manifest present the script
   never re-queries the API and downloads only what is missing, so a machine with
   no Unsplash key at all reproduces the identical seed, and a warm cache needs
   no network whatsoever. The binaries live in `scripts/fixtures/photos/`, which
   is gitignored — 6.6 MB of JPEG does not belong in git history.
3. **A keyless fallback that is still photographs.** With no key AND no manifest,
   it falls back to `picsum.photos` at fixed ids: keyless, deterministic (an id
   always returns the same image), and Unsplash-sourced anyway. Never gradients.
   The script says loudly what is missing and how to fix it.

`UNSPLASH_ACCESS_KEY` is read only by this script, running on the host. It is
deliberately NOT in any compose service's environment, and it is an empty entry
in `.env.example`.

**Unsplash's search endpoint returns transient 5xx for valid queries**, verified
rather than guessed: "apartment interior", "indian house exterior" and "balcony"
each failed with 502/503 two to four times in a row and then succeeded, while
"bedroom" and "living room" answered first time, and the identical requests
succeeded through curl throughout. It is not the key, the spaces or the
parameters. So a 5xx is retried with backoff (8 attempts) and only a 4xx stops
the run — a 401 and a 403 get their own messages, the 403 one printing the
rate-limit header, because "wrong key" and "you have used your 50 an hour" need
different actions.

**Attribution** is honoured as the API terms require: the per-photo
`download_location` endpoint is triggered when a photo is actually cached (not on
a cache hit — that is not a download), and `docs/attribution.md` is generated from
the manifest crediting every photographer with a link to their profile and to the
photo. The seeded UI carries a dev-only "seed photos via Unsplash" line on the
listing gallery.

One trap worth recording: `packages/db/prisma/seed.ts` imports
`readPhotoManifest` from the fetcher, and the fetcher's `main()` was initially
unguarded — so importing it started a network fetch, which is exactly the
coupling the split exists to prevent. It now guards on `process.argv[1]`, the
same way `scripts/cities.ts` does.

### D32. Dev account passwords are hashed by Better Auth's own hasher

`prisma/seed.ts` imports `hashPassword` from `better-auth/crypto` rather than
hand-rolling scrypt. If the library changes its hash format, the seeded accounts
change with it instead of silently failing to sign in. Verified: all three dev
accounts sign in and `/api/me` reports the right role and verified state.

## Step 5 — listing CRUD and the image pipeline

### D33. The listing input schema is deliberately narrower than the model

`listingDraftSchema` has no `ownerId`, `status`, `isVerified`, `viewCount` or
`publishedAt`. Those are the server's to decide, so a client that sends them is
ignored rather than trusted — and a test asserts exactly that by posting
`ownerId`, `status: PUBLISHED` and `isVerified: true` and checking the stored row
comes back owned by the session user, DRAFT and unverified.

Drafts validate loosely and publishing validates strictly
(`publishableListingSchema`): a half-filled draft is the point of a wizard, but a
live listing must have the price that matches its type and a floor that fits
inside its building.

### D34. Image derivation runs in the worker, never in the request path

The first cut of this step put sharp in `apps/api` and derived variants inside the
`complete` request. That was wrong on four counts, and the design now reflects it:

- uploads already go browser-to-storage through a presigned URL, so deriving in
  the API meant downloading the object back just to resize it — a pointless hop.
- libvips spikes CPU and RSS. A twelve-photo listing upload should not be able to
  degrade request serving; that work belongs in a process that can be scaled,
  memory-capped and restarted on its own.
- it keeps sharp's platform-specific native binaries out of the API image, which
  are a recurring source of multi-stage build pain.
- BullMQ, retries and backoff were already wired for the fuel scraper. Image
  derivation is the same shape of work.

The API now only signs uploads, confirms via `headObject` that the object landed,
and enqueues. It reads no image bytes at all.

`sharp` appears in exactly two `package.json` files: `apps/worker` (runtime) and
`packages/db` (dev-only, so the seed derives its fixtures through the same code
the worker runs). It is a _peer_ dependency of `packages/shared` and the
derivation module sits behind the `@machiya/shared/images` subpath, so importing
`@machiya/shared` from the browser app can never pull libvips into the web bundle.

### D35. Two prefixes, two access policies

`originals/` is private; `variants/` is the only publicly readable path.

The compose `minio-init` step previously ran `mc anonymous set download` on the
**whole bucket**. Since uploads land straight from the browser and are not known
to be images until the worker decodes them, that made every unvalidated upload
publicly fetchable — anything anyone PUT with a valid ticket was served. It now
runs `anonymous set none` on the bucket first (so a bucket created by the older
file is narrowed rather than left open) and grants `download` on `variants/` only.

Verified: a variant fetches anonymously with HTTP 200, an object under
`originals/` returns 403.

### D36. Presigned POST with a length condition, not a presigned PUT

A presigned PUT cannot bound the request body — a client could stream a gigabyte
through a ticket issued for a 12 MB photo, and the API would find out only when
the disk filled. A presigned POST policy carries `content-length-range` and an
`eq` condition on the content type, so the storage service rejects an oversized
or wrong-typed upload before a byte reaches us.

Verified: a 13 MB body against a fresh ticket is refused by MinIO with HTTP 400.

That bounds abuse, not deceit — which is what the next entry is for.

### D37. The declared content type is never trusted; magic bytes decide

`validateAndDerive` sniffs the real format with `file-type` before sharp touches
the bytes, then decodes to confirm. A file's extension and its declared
`Content-Type` are both attacker-controlled and prove nothing.

Verified end to end through the real API and worker:

| Uploaded as `image/jpeg` | Outcome                                                                           |
| ------------------------ | --------------------------------------------------------------------------------- |
| a real JPEG              | READY, 1200x800, six variants, dominant colour                                    |
| a shell script           | REJECTED — "That file is not a recognisable image"                                |
| a PDF                    | REJECTED — "Images must be JPEG, PNG, WebP or HEIC — that one is application/pdf" |

Also rejected: anything over 12,000px on a side, and animated inputs — a
multi-page WebP would otherwise be silently flattened to one frame.

HEIC is accepted in the allowlist but sharp prebuilds usually cannot decode it,
so the code checks `sharp.format.heif.input.buffer` at runtime and returns a
clear "export as JPEG instead" rejection rather than an opaque decode crash.

EXIF is stripped by rotating first (`.rotate()` applies the orientation tag then
drops it) and writing no metadata — so GPS coordinates and camera serials in a
phone photo never reach the bucket, which matters when the subject is somebody's
home. A test asserts the derived output has no `exif` and no `orientation`.

### D38. Rejection and failure are different, and are handled differently

`ImageRejected` means the file is the problem: terminal, mark `REJECTED` with the
reason, delete the original, do not retry. Three attempts at the same corrupt
JPEG is three times the work for the same answer. Anything else — a storage blip,
an OOM — is rethrown so BullMQ backs off and retries, and only once attempts are
exhausted does the row become `FAILED`. Flipping it early would show the user a
dead end while a retry was still pending.

Idempotency is the image id: it is the BullMQ job id, so a double-tap or a
redelivered request collapses onto one job, and a job for an already-`READY`
image returns immediately. (BullMQ 6 rejects `:` in a custom job id, so it cannot
be namespaced — the queue name already scopes it.)

Publishing requires at least one image with status `READY`, not merely present: a
`PENDING` row is an upload the worker has not decoded, so publishing on it would
put a listing live with no servable photo. The 422 distinguishes "still being
processed" from "add a photo", because those need different actions from the user.

An hourly `cleanup-images` job sweeps `PENDING` rows older than 24h and orphaned
originals with no matching row. Verified by backdating the pending rows and
running it: 4 swept, the originals prefix emptied, READY and REJECTED untouched.

## Correction 2 — autocomplete

### D39. Autocomplete is two tiers: pg_trgm locally, Nominatim only when that falls short

Removing Photon (D26) left one real requirement behind: type-ahead has to feel
instant. A round trip to a geocoder per keystroke does not, whoever hosts it.

**Tier 1 is `pg_trgm` over our own rows** — `City.name`, `Locality.name`, and the
`title` and `address` of PUBLISHED listings — with GIN `gin_trgm_ops` indexes
declared in `schema.prisma` (Prisma emits them from
`@@index([name(ops: raw("gin_trgm_ops"))], type: Gin)`, so no hand-written
migration is needed; same reasoning as D13). One statement, three sources, a
`UNION ALL` and a score.

`Locality` had to become a table for this. It existed only as literals in
`scripts/cities.ts`, and a trigram search over a TypeScript array is not a
search. The seed writes them and prunes any that leave `cities.ts`, so the two
cannot drift.

Two match paths, and the second is not optional:

- `%`, the trigram similarity operator, which is what makes "koramangla" find
  Koramangala. Verified against the seeded database: similarity 0.64.
- a case-insensitive prefix, which is what makes a short query work at all.
  `similarity('Koramangala', 'ko')` is about 0.18 — under any useful threshold —
  and "ko" is exactly how someone starts typing it. Verified: "ko" returns
  Koramangala and Kothrud at 0.92, "hinjew" returns Hinjewadi, "zzzz" returns
  nothing.

A prefix hit scores 0.92 rather than 1.0 so a true trigram match still wins, and
listing rows are multiplied by 0.8: a locality is a better answer to "where is
your office" than a listing whose title happens to contain the word.

**Tier 2 is Nominatim**, and it is reached only when tier 1 returned fewer than
five results AND the term is at least three characters. Both bounds are in
`@machiya/shared` so the client and the server agree on them. Results are cached
in Redis for seven days under a normalised query — trimmed, lowercased,
whitespace-collapsed — because "Boring Road", "boring road" and "BORING ROAD "
are one question, and without normalising they were three cache entries and
three upstream calls.

The client adds the other half of the restraint: a 250 ms trailing debounce, and
React Query's own `AbortSignal`, which cancels the in-flight request when the
term changes. The API forwards that abort to Nominatim, so an abandoned
keystroke stops work upstream rather than merely being ignored on arrival.
`placeholderData` keeps the previous list visible while the next loads —
without it the dropdown empties and refills on every pause, which reads as
flicker and makes a fast list feel slow.

**One endpoint, one ranked list, a `source` per row.** The two tiers merge behind
`/api/places/suggest`, and the scores are deliberately on one 0-1 scale so
merging them is meaningful rather than arbitrary: Nominatim's own `importance`
is rescaled to sit below a tier-1 prefix hit and above a weak trigram one.

De-duplication is by normalised label plus coordinates rounded to ~100 m. On a
collision **the local row wins regardless of score**, because it is the one
carrying a `citySlug` and, for a listing, a slug — the things the UI needs to act
on a selection. Two Koramangalas 300 km apart still both appear; the same
Koramangala from both tiers appears once.

`degraded` means one specific thing: tier 2 was needed and answered nothing.
Tier 1 being sufficient is the fast path, not a degradation, and conflating the
two would have the UI apologising on its best case.

Verified by 16 tests in `apps/api/test/places.test.ts` against real Postgres for
tier 1 (a mocked query would prove nothing about trigram behaviour) and a stubbed
provider for tier 2, since what needs testing there is the gating and the merge,
not Nominatim. Included: a DRAFT listing is never suggested, because the local
tier is a public surface.

## Correction 4 — the image dual write

### D40. The PENDING row IS the outbox; what was missing was a reconciler

Amends D38. The sharp-in-worker split (D34) and the rejection/failure
distinction (D38) both stand. The hole was elsewhere.

`ListingImage` commits to Postgres and the BullMQ job goes to Redis. Two
systems, no transaction across them. If the enqueue threw — a Redis blip, a
failover, the API dying in the gap — the row was committed and nothing was ever
coming for it. It sat in the gallery as a spinner until the 24-hour cleanup
sweep deleted it: the user's upload silently vanished, hours later, with no
error anywhere the user could see. Worse, the old code enqueued BEFORE updating
the row and let the enqueue failure reach the client as a 500, so the user was
told the upload failed while the row stayed committed.

**No outbox table.** The `PENDING` row already is the durable record of intent,
and the job id already equals the image id, which makes enqueueing idempotent by
construction. A separate `Outbox` table would duplicate a row that already
exists, add a write to the hot path, and need its own drain anyway. What was
missing was not a record — it was something to notice.

So:

1. **The enqueue happens strictly after the commit, never inside it.** And if it
   throws, it is logged and the request still returns success. The bytes are in
   the bucket, the row is committed, the reconciler will pick it up — telling the
   user their photo was lost would be false, and there is nothing they could do
   differently anyway. Never roll back a committed upload because Redis hiccuped.
2. **A `reconcile-images` repeatable job every 60 seconds.** It selects `PENDING`
   rows older than two minutes, oldest first, bounded to 100 per run, asks the
   queue directly whether a job with that id is active/waiting/delayed — the id
   being the image id is what makes that a single lookup rather than a queue scan
   — and enqueues the ones nothing is working on. The grace period matters: a row
   committed a second ago is one whose enqueue is very likely in flight, and
   racing it would resize the same photo twice.
3. **A `reconcileAttempts` counter on the row.** After five re-enqueues without
   reaching a terminal state the row becomes `FAILED` with a reason the user can
   act on. A row that never processes is a bug to surface, not a loop to hide.
4. **The hourly cleanup sweep stays, and now means what it says.** Anything
   enqueueable is drained within minutes, so a `PENDING` row that survives to the
   24-hour cutoff really is an upload the client never completed.

One case is NOT idempotent on its own and the reconciler handles it explicitly: a
job that ran to completion while the row stayed `PENDING` — the process died
between the resize and the database update. BullMQ keeps finished jobs and `add`
with an existing id is a **silent no-op**, so the corpse is removed before the id
is reused. Without that the row would be stranded permanently, which is the exact
class of bug this entry exists to close.

**What would justify a real outbox table:** more than one unrelated side effect
per transaction. The moment a single commit has to reliably produce, say, a queue
job _and_ an email _and_ a webhook, the row-as-outbox stops working — there is no
single column that means "all three happened", and you are back to needing an
append-only log of intents with per-intent delivery state. One side effect, one
status column, one reconciler is the whole of it.

Verified by 10 tests in `apps/worker/test/reconcile-images.test.ts` against real
Postgres and real Redis — a mocked queue would prove nothing about `getJob`, job
states or id collisions, which is precisely where the bug lives. The headline
test commits a `PENDING` row without enqueueing anything and asserts it reaches
`READY`. The job processor is the one substitution: derivation needs sharp and
object storage and is covered elsewhere, so the test's processor stands in for it.

## Correction 3 — seed photos

### D41. An image row stores where its variants live, rather than recomputing it

The old code built variant keys from `(listingId, imageId)` at four separate call
sites. That made a shared photo impossible, which mattered the moment the seed
started using 23 real photographs: one private copy per listing would be roughly
1,200 objects of identical bytes — around 90 MB of duplicated JPEG and WebP in a
development bucket, to show 23 distinct pictures.

Note that the first version of D31 already CLAIMED the fixtures were "uploaded
once and shared" while the code wrote a private copy per listing. The claim was
aspirational; this is the change that makes it true.

`ListingImage.variantBaseKey` is now a NOT NULL column holding the prefix without
the `/{size}.{ext}` tail:

- an upload gets `variants/{listingId}/{imageId}`, set when the PENDING row is
  created — both ids are known then, which is why the column can be required.
- a seeded photo gets `variants/fixtures/{photoId}`, written once and pointed at
  by every listing that draws that photo.

One column, one source of truth, and the URL for an image is no longer derived
independently in the API, the worker and the seed.

The hazard this creates is deletion, and it is guarded explicitly:
`isListingOwnedVariantBase(baseKey, listingId)` is checked before a listing's
variant objects are deleted, so removing one seeded listing cannot blank the
gallery of every other listing sharing the same photo. The rule is one line and
lives next to the key helpers rather than being remembered at each delete site.

The migration is hand-edited: Prisma's generated version added a NOT NULL column
with no default to a populated table, which cannot run. The value is derivable
for every existing row — it is exactly what the old code computed — so it is
backfilled in place and only then constrained.

## Step 7 — the detail view

### D42. Overpass is warmed in the background; a request never waits for it

The brief asks for a single batched Overpass query per listing, cached 24h,
degrading on 429 rather than failing. All of that stands. What measurement
added is that **the query is far too slow to be on a request path at all**.

Measured against `overpass.kumi.systems`, the batched seven-category query
inside 1.5 km of a Koramangala address:

| Attempt                           | Result                   |
| --------------------------------- | ------------------------ |
| `out center tags qt;`             | 200 in 38s, 343 elements |
| same query, `out center tags;`    | still running at 60s     |
| `qt`, later in the day            | 200 in 85s               |
| radius reduced to 1 km, with `qt` | still running at 90s     |

Two things follow. First, **`qt` is not a nicety** — sorting by quadtile index
rather than by id is the difference between an answer and a timeout, and it is
now in the query. Second, the narrower query timing out while the wider one
succeeded means the variance is the mirror queueing us, not the query's cost, so
there is no version of this that is reliably fast.

So the POI lookup **never blocks**: a cold read returns
`{ pois: [], degraded: true }` immediately and starts a background warm; the
client polls every 8 seconds while the answer is degraded and empty, and picks
up the real one when it lands. Every later viewer of that listing is served from
cache for 24 hours, and a second key holds a two-week copy so a later refusal
has something to serve. An in-flight key set means ten simultaneous viewers
produce one upstream query.

`degraded` already meant "could not refresh, not necessarily empty", so this is
exactly the state it exists for — and the panel says "checking" while warming
and "could not refresh" afterwards, never "none nearby".

`OVERPASS_TIMEOUT_MS` therefore defaults to **90 seconds**. That is not a request
timeout: it bounds a background job and the `[timeout:]` inside the Overpass
query, and nothing waits on either.

**The default mirror is NOT `overpass-api.de`.** It answers **406 Not
Acceptable** to every User-Agent tried except curl's own — verified across four:
no UA, `Machiya/0.1 (contact@example.com)`, `Mozilla/5.0 machiya/0.1`, and
`curl/8.0.1`, of which only the last got a 200, with the identical query and
parameters. Spoofing curl to get past a mirror's own policy is not a fix, so the
default is the Kumi Systems mirror, which accepts a descriptive UA. Alternatives
and the self-host path are in `docs/geo.md`.

One smaller bug the same work exposed, now fixed in all three geo providers:
passing only the caller's `AbortSignal` — which is the request-close signal —
**silently removed the timeout**, and a slow mirror held a request open past 45
seconds instead of degrading at 25. They now pass
`AbortSignal.any([caller, AbortSignal.timeout(ms)])`, so the ceiling holds
whether or not a caller supplies one.

### D43. A route we could not measure is labelled, not hidden

When OSRM has no answer — the graphs are not built, the container is down, or
there is genuinely no route — the commute panel shows a straight-line estimate
(a 1.35 detour factor, 22 km/h by car and 18 by bike) with `degraded: true`,
and the UI says so in words next to it.

The alternative was showing nothing, and it is worse. The commute number is the
entire argument of this product; a blank panel reads as "this listing has no
commute" rather than "we could not measure it". But presenting an estimate as a
measurement would be worse still, so the flag travels with the number all the
way to the sentence under it.

`osrm-routed` **ignores the profile segment in the route URL** — the graph it was
given decides the profile — so the profile selects the base URL and the path
segment is the literal `driving` for both. Writing `bike` there would produce
plausible car answers labelled as bike ones, which is the sort of wrong that
never surfaces as an error.

### D44. A view is one viewer per window, and the owner is not a viewer

`ListingView` rows are what the analytics chart aggregates; `Listing.viewCount`
is what the search query reads. Both are written in **one transaction**, so they
cannot disagree — and a seed that disagreed with itself would look like a bug in
whichever one you checked second.

Three rules make the number mean something:

- **Deduplicated per viewer per 30 minutes**, keyed on the signed-in user id
  when there is one. Without it the count measures refreshes.
- **Anonymous viewers are keyed on a SHA-256 of IP + user-agent**, truncated.
  Hashed because a raw IP in Redis is personal data this product has no use for,
  and a one-way digest keys a counter just as well.
- **The owner reading their own listing does not count.** This is the single
  biggest source of nonsense in a small site's numbers.

A failed write is swallowed with a log line. Telemetry must never fail a page
render, and there is nothing the user could do about it anyway.

### D45. The detail view is a child route of the search, not a sibling

`/listings/:slug` renders as a panel inside the search page's map column,
through an `<Outlet />`. Making it a sibling route would unmount the search on
every navigation — which means tearing down a WebGL context, refetching every
tile, losing the camera and the scroll position, and paying for all of it again
on the way back.

Two consequences worth knowing:

- **What the panel wants drawn on the map arrives through a store**
  (`stores/detail-overlay.ts`), not props: the panel is below the map in the
  tree, so the route geometry and the POIs would otherwise have to be lifted
  into the search page, which would then re-render on every POI arrival.
- **Closing is `navigate(-1)`** when there is history, so the search returns
  exactly as it was rather than being rebuilt from the URL.

The panel renders as a springing sidebar on desktop and a drag-dismissable
bottom sheet on mobile, and it renders **one or the other** — chosen by a
`matchMedia` hook rather than by rendering both and hiding one with `lg:hidden`.
That was not a preference: hiding one put the entire listing in the DOM twice,
with two `aria-label="Listing detail"` landmarks and every control duplicated,
which a Playwright strict-mode violation caught before a person had to.
