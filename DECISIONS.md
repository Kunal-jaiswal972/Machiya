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

### D42. The measurements that made a public Overpass mirror untenable

Rewritten. The original version of this entry chose a public mirror and a
never-block design around its latency. The mirror choice is **superseded by
D48** — Overpass is self-hosted from the merged extract now, and a mirror is a
fallback only. What stands, and what this entry is kept for, is the
measurement, because it is why the fallback is a fallback and why two pieces of
the implementation look the way they do.

Measured against `overpass.kumi.systems`, the batched seven-category query
inside 1.5 km of a Koramangala address:

| Attempt                           | Result                   |
| --------------------------------- | ------------------------ |
| `out center tags qt;`             | 200 in 38s, 343 elements |
| same query, `out center tags;`    | still running at 60s     |
| `qt`, later in the day            | 200 in 85s               |
| radius reduced to 1 km, with `qt` | still running at 90s     |

Three things follow, all of them still live:

- **`qt` is load-bearing, not a nicety.** Sorting by quadtile index rather than
  by id is the difference between an answer and a timeout. Note that the
  original entry claimed this was "now in the query" and the code emitted
  `out center tags;` — the claim was aspirational for two weeks. D48 is the
  commit that actually put it there, and `apps/api/test/overpass.test.ts`
  asserts the request body contains it so the claim cannot go stale again.
- **The variance is the mirror's queue, not the query's cost.** The narrower
  1 km query timed out while the wider 1.5 km one succeeded. There is therefore
  no version of a public mirror that is reliably fast, which is the substance of
  why one cannot be the default — the fair-use argument is real but secondary.
- **`overpass-api.de` is not usable at all.** It answers **406 Not Acceptable**
  to every User-Agent tried except curl's own — verified across four: no UA,
  `Machiya/0.1 (contact@example.com)`, `Mozilla/5.0 machiya/0.1`, and
  `curl/8.0.1`, of which only the last got a 200, with the identical query and
  parameters. Spoofing curl to get past a mirror's own policy is not a fix. So
  when a mirror is used at all, it is one that accepts a descriptive UA, and the
  `accept` and `user-agent` headers stay on the request for that path.

`OVERPASS_TIMEOUT_MS` therefore had to be 90 seconds against a mirror. Against
the local instance it defaults to 30, and the cold-read wait that used to be
"never" is now a 3-second bound — see D48 for both.

One smaller bug the same work exposed, fixed in all three geo providers and
still the rule for any fourth: passing only the caller's `AbortSignal` — which
is the request-close signal — **silently removed the timeout**, and a slow
upstream held a request open past 45 seconds instead of degrading at 25. They
pass `AbortSignal.any([caller, AbortSignal.timeout(ms)])`, so the ceiling holds
whether or not a caller supplies a signal.

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

## Correction 7 — the geo artifacts

### D46. Derived cache keys are scoped to a geo epoch, not flushed by hand

Routes, POIs and geocodes are all **derived from the OSM artifacts**: the two
OSRM graphs, the Nominatim database and (from D48) the Overpass database, each
built from one merged extract. A cached entry is therefore only valid for the
artifacts that produced it — after a re-cut with different bounds, the same key
names a different answer, and the wrong one.

**Chosen: a geo epoch prefixed onto every derived key.** It is a 12-hex-character
hash of the artifact-relevant city config plus the sha256 of every source zone
extract, computed by `computeGeoEpoch` in `@machiya/shared/cities` and written
into `osm-data/manifest.json` as the last step of `scripts/bootstrap.sh`. The
API reads it once at boot and `geoCacheKey()` puts it in front of every route,
POI and geocode key.

A rebuild then changes the epoch and every derived entry becomes **unreachable**
without anyone flushing anything; the orphans expire on their own TTL. That
beats a manual flush in the two ways that matter: nobody has to remember, and a
partial rebuild on one machine cannot serve another machine's geometry — the
epoch differs, so the two never read each other's keys even against a shared
Redis.

Verified against the compose Redis rather than a mock, because the whole
mechanism _is_ the key string and a mocked cache would prove nothing:
`apps/api/test/geo-epoch.test.ts` caches a route and a POI set under a random
epoch, re-imports the module graph against a manifest carrying a different one,
and asserts the second read re-derives — one upstream call becomes two, and the
POI panel goes back to `degraded` with an empty list instead of serving the
previous epoch's answer. Directly observable in `redis-cli --scan` too: the
pre-correction `route:bike:25.6191,85.1767:...` keys are still present and now
unreachable, sitting next to a `<epoch>:route:car:...` one.

Four details worth stating, because each was a decision:

- **The forward-geocode cache is scoped too**, keeping its 7-day TTL.
  Nominatim's answers come from the imported extract, so they are as derived as
  a route is. The TTL is about churn in what a query _should_ return; the epoch
  is what makes the entry **correct** across a rebuild. This is stated in
  `docs/geo.md` as well, because a 7-day TTL reads like the safety mechanism
  and is not one.
- **`view:{listingId}:{viewerHash}` is deliberately NOT prefixed.** A view
  dedupe window has nothing to do with OSM data, and prefixing it would reset
  every window on a rebuild — turning an artifact rebuild into a spike in view
  counts.
- **The POI key gained a category component** at the same time. `nearby()`
  accepts a subset of the seven categories while the key described only the
  centre and the radius, so a future two-category caller would have written its
  answer over the key the seven-category panel reads. It is `all` for the full
  set so the common key stays readable.
- **With no manifest the epoch is the literal `unbuilt`**, logged at warn with
  the path. The core stack is usable before `pnpm bootstrap` has ever run (D6),
  so a missing manifest cannot be fatal — but it must not be silent either, and
  inventing a plausible-looking epoch would make the first real build look like
  a no-change rebuild.

The config hash is deliberately narrower than the city record: slug, zone and
bbox only. Transit fares and locality names are seed data — changing one does
not invalidate a routing graph, and hashing them here would raise a
stale-artifact alarm that no rebuild could clear.

One real bug fell out of writing the test, and it was not the epoch's:
`apps/api/src/lib/cache.ts` issued its first command on a `lazyConnect` client
with no offline queue (D21), so the **first cache read and write of a fresh
process both rejected**. A cold POI warm immediately after boot therefore
persisted nothing and the next viewer warmed the identical key again. `ready()`
now connects once and every read and write awaits it. Still no socket at import
time: a test that touches a service must not need a Redis.

### D47. Two bboxes per city: an administrative one and a padded one the extract is cut from

The city bboxes were cut tight — roughly the built-up area and nothing else —
and step 7 had been exercising the consequence without naming it. With a 3 km
search radius around an **arbitrary** office, a tight cut is not an edge case:

- a listing or office within a few kilometres of an edge gets a **truncated**
  POI answer. Half of a 1.5 km circle contains no data, and the panel says
  "3 schools nearby" rather than "we cut the map here". Nothing in the response
  distinguishes a genuinely quiet area from a boundary artifact.
- a **route** is not bounded by either radius. A road from an office near one
  edge to a listing near another can legitimately leave the box and come back,
  and a graph that ends mid-carriageway answers either `NoRoute` or an absurd
  detour — the second being the worse one, because it looks like a measurement.

**Chosen: every bbox is padded by 9 km before `osmium extract`, and both boxes
are kept in the city record.** `paddedBbox` is what artifacts are cut from;
`bbox` stays the administrative box that answers "is this locality inside its
city" and "are two cities ambiguous to assign between". Conflating them would
make the overlap check in D50 meaningless — every city would overlap its
neighbours by 18 km of padding and the validator would either fire constantly
or be written to ignore the thing it exists to catch.

9 km rather than 3-5: the radii would justify 5, but a route is unbounded, and
the marginal cost is a few MB of extract per city.

**`paddedBbox` is derived, never written by hand.** `padBbox()` in
`@machiya/shared/cities` computes it from `bbox`, and `CITIES` attaches it once
so no caller can cut an artifact from the administrative box by accident. Two
hand-maintained boxes would drift, and the drift would read as a data bug in
whichever one was checked second. The longitude pad is computed at the latitude
**furthest from the equator**, where a degree of longitude is shortest, so the
pad is at least 9 km everywhere in the box rather than only at its centre.

The same work closed a second, quieter bug in `bootstrap.sh`: **"the file
exists" meant "skip"**, so changing a bbox left every earlier cut in place and
the whole pipeline kept serving geometry from the old bounds — an artifact
staleness bug that would have made this correction look like it had landed when
it had not. Each cut is now stamped with the bounds it was made with
(`.osm-cache/<slug>.bbox`) and re-cut when they differ; a re-cut forces the
merge; and `osrm-init` stores the extract's sha256 next to each graph and
rebuilds when it no longer matches. Nominatim and Overpass import on first boot
only, so those two re-imports are volume drops — `pnpm geo:status` (D51) prints
the exact commands.

Verified three ways:

- `packages/shared/test/bbox.test.ts` — 6 tests on the arithmetic, run: every
  side grows by at least 9 km and not much more, the unpadded box is contained
  in the padded one, a point 4 km outside the administrative edge is inside the
  padded box and outside the unpadded one, padding never produces an invalid
  box, and two boxes 1,000 km apart still report no intersection once padded.
- `apps/api/test/geo-boundary.test.ts` — the live pair, which only real
  services can answer. A car route between two points that Bengaluru's old
  `maxLng` of 77.78 split (Whitefield to Hoskote) must return real geometry
  rather than `degraded`, and a POI lookup centred exactly on the old edge must
  return places on **both** sides of it. The POI assertion is deliberately
  "some POIs east of 77.78" rather than a count, because a truncated
  half-circle still has places in it. The measured results are in
  `docs/audit-2026-09.md` under the rebuild.
- the epoch moved on its own, which is D46 working as intended: adding
  `paddedBbox` to the hashed config changed `configHash` away from
  `2e8d102364f5`, so every route and POI cached against the old cuts became
  unreachable with nothing flushed.

### D48. Overpass is self-hosted from the same extract; a public mirror is a fallback

"Public instance, self-hosting as the scale path" stopped being defensible the
moment the merged extract existed. Two reasons, and the second is the one that
matters more:

1. **The mirrors ask people not to build products against them.** That was
   always borrowed time, and D42's own findings are the evidence: one mirror
   answers 406 to every User-Agent but curl's, another 504'd under this load,
   and the batched query took 38-85 seconds depending on the mirror's queue
   rather than on the query.
2. **POIs came from planet-current OSM while routing and geocoding came from a
   fixed extract.** So a listing's road graph and its nearby-hospital list
   could disagree about what exists — a hospital tagged last month appears in
   the POI panel and not in anything derived from the extract, and there is no
   way for a reader of a bug report to tell that apart from a code bug. It is
   unfalsifiable, which is the worst property a discrepancy can have.

**Chosen: `wiktorn/overpass-api:v0.7.62.11` in the `geo` profile, initialised
from `osm-data/merged.osm.pbf` — the same file OSRM and Nominatim read** — with
its own `overpass-db` volume. `OVERPASS_URL` stays, so a public mirror is a
one-line fallback, and `docs/geo.md` says plainly that it is a fallback and
never the default.

Configuration, each setting for a reason rather than copied from a README:

- **`OVERPASS_META=no`.** Changeset ids and user attribution are dead weight
  for a POI lookup and roughly halve the database.
- **`OVERPASS_DIFF_URL` unset — diff updates disabled entirely.** A fixed
  snapshot is a feature here, the same reasoning that makes the seed
  deterministic (D29): screenshots and bug reports have to be comparable across
  machines, and POIs drifting under a fixed routing graph is precisely the
  problem this entry exists to remove.
- **`OVERPASS_USE_AREAS=false`.** Nothing in this codebase uses `area` or
  `is_in` — every query is `around:` — and area generation is a large slice of
  both the initial import and the ongoing updater process.
- **`OVERPASS_PLANET_PREPROCESS` converts PBF to bz2 in place.** Overpass's own
  init reads OSM XML, not PBF; the image ships `osmium`, so the conversion is
  three shell commands rather than a second artifact on disk. `file://` URLs
  work because the entrypoint fetches with curl, so the service really does read
  the same bytes as the other two.
- **No `platform:` pin, unlike OSRM (D26).** Verified:
  `docker manifest inspect wiktorn/overpass-api:v0.7.62.11` returns a manifest
  **list** with `linux/arm64` and `linux/amd64` entries, so Apple silicon runs
  it natively.
- **The healthcheck runs a real interpreter query** (`node(1);out ids;`) rather
  than probing the port. Overpass answers HTTP long before its database is
  queryable, so a port probe reports healthy in the middle of an import — and
  the API would then serve empty POI sets while every check was green.
  `start_period` is 45 minutes so a cold init is not mistaken for a wedged
  container. `bootstrap.sh` waits on the same query for the same reason.

**What was simplified, and what deliberately was not.** The 429/504 special
case is gone: it existed to be polite to a shared service, and a local instance
either answers or is down. `!response.ok` throws, the caller degrades the panel,
and that is the whole error path.

The Redis cache and the 24h TTL **stay**, with a rewritten justification: the
reason is now query cost, not fair use. A revisited sidebar has to be instant,
and a seven-selector `around:` scan is not free even locally. The two-week
`:stale` copy stays for the same reason it always existed, but what it now
protects against is the geo profile being down rather than a mirror refusing.
One batched query per listing also stays, on its own merits — seven queries are
seven scans of the same neighbourhood and seven round trips, and the panel would
fill in seven steps instead of at once.

**The cold read changed shape, because the measurement it was built on no
longer holds.** D42's answer-immediately-and-poll design existed because the
query took 38 seconds. A cold read now starts the warm and waits
`OVERPASS_COLD_WAIT_MS` (default 3 s) for it, so against the local instance the
panel is simply populated and the client never polls. The bound is what keeps
the wait from becoming a dependency: an importing or wedged Overpass degrades
the panel instead of holding a request open, and the client's 8-second poll
still picks up the answer when it lands. The warm remains untied to the
request's abort signal, so closing the sidebar still leaves the cache warm.

The `degraded` UI state stays but now names the real remaining cause. It is no
longer "a mirror rate-limited us" — it is **the geo profile is not up**, which
has a completely different fix, so the panel's dev-only line names
`docker compose --profile geo up -d` instead.

Also fixed here, because it contradicted D42 rather than merely being stale:
the query builder emitted `out center tags;` while D42 had measured `qt` as the
difference between a 38-second answer and no answer at all. It now emits
`out center tags qt;`.

Verified: `docker manifest inspect` for the platform claim, and 4 tests in
`apps/api/test/overpass.test.ts` against real Redis and a stubbed upstream —
a fast upstream populates the cold read rather than degrading it, the request
body contains `qt`, a 5-second upstream degrades in under the bound and the
warm still lands afterwards, and a refusing upstream serves the `:stale` copy
marked degraded rather than an empty list. The live-service assertions are in
`apps/api/test/geo-boundary.test.ts` and the measured import numbers are in
`docs/audit-2026-09.md`.

## Correction 8 — adding a city is a tested path

### D49. One city record, in `@machiya/shared/cities`, validated in CI

The brief asserts a new city is a one-entry change to `scripts/cities.ts`. That
was true of the code and **false of the data**. Four things were per-city and
none of them lived in the city record:

- fuel scraper slugs per source (not written yet, but step 8's adapters key off
  them, and two of the three sources still index Bengaluru as `bangalore`);
- transit fare tables (in the record already);
- localities with coordinates (in the record already, but nothing checked them);
- every geo artifact — none rebuilding incrementally, none detecting that the
  config had changed.

The failure mode is the nasty kind: a fourth city that geocodes and routes to
nowhere while every page renders and every probe passes.

**Chosen: the record holds everything, and it moved to
`@machiya/shared/cities`.** Slug, display name, state, Geofabrik zone,
centroid, unpadded bbox, padded bbox, boundary polygon, localities with
coordinates, transit fare table, and a per-source fuel slug map. Nothing
city-specific is hardcoded anywhere else.

The move out of `scripts/` was forced, not cosmetic: the API has to read the
city list to notice that the artifacts predate the running config (D51), and
`apps/api` cannot import from `scripts/` — it is built to `dist` and deployed
through `pnpm deploy --prod`, which does not include the root scripts
directory. A copy would have meant two lists. `scripts/cities.ts` remains as
the shell-facing CLI, because `bootstrap.sh` shells out to it, and re-exports
the config so the old import path still resolves.

Why a **subpath** (`@machiya/shared/cities`) rather than the package index: the
module graph reaches `node:crypto` for the config hash, and pulling that into
the browser app breaks the Vite build. Same reasoning as
`@machiya/shared/images` and sharp (D34). Nothing in the web app needs the city
config — it reads `/api/cities`.

Two fields are **derived rather than written**, so they cannot drift from their
sources: `paddedBbox` from `bbox` (D47) and `boundary` from the generated
module (D50). Two hand-maintained copies of the same fact drift, and the drift
reads as a data bug in whichever one you check second.

**`scripts/validate-cities.ts` runs in CI** and fails on: a missing or
nonsensical record field, a fuel source with no slug for a configured city, a
locality with no coordinates, a locality outside its city's **unpadded** bbox,
and two **padded** bboxes overlapping by more than 25 km². Note which box each
of the last two uses — localities are validated against the administrative box
because that is what "in this city" means, and overlap against the padded box
because that is what is actually cut. Conflating them makes one of the two
checks meaningless.

The 25 km² tolerance is not zero on purpose: two cities 60 km apart with 9 km
of padding each can have a thin overlap between their extracts, and a point in
it is assigned by containment against the boundaries rather than by the box
(D50). What the threshold catches is an overlap large enough that the
nearest-centroid **fallback** would have to arbitrate a meaningful area — and
that fallback is a guess.

The rules live in `packages/shared/src/cities/validate.ts` rather than in the
script, so they can be unit-tested against deliberately broken configs. A
validator with no tests is one nobody trusts when it fires, and worse, one
nobody notices when it stops firing. 12 tests in
`packages/shared/test/validate-cities.test.ts`, each a way a city has actually
been added wrong: Koramangala's coordinates under a Patna record, a source
added to the registry with one city not updated, a slug with a space in it, an
inverted bbox, two extracts 11 km apart.

`Locality` is also a database table and the seed prunes it against this config
(D39). Those are two different jobs, deliberately: the validator checks the
source of truth, the seed keeps the table honest about it.

**A missing boundary is a warning, not an error.** The polygons are derived
from a local Nominatim, so a clone that has never run `pnpm bootstrap` has
none — and the app still works, through the nearest-centroid fallback. Failing
CI on it would mean CI could only pass on a machine with 3 GB of OSM artifacts.

### D50. City assignment is containment first, nearest centroid second — and says which

Nearest centroid alone is what step 5 did, and it is right for exactly as long
as the cities are far apart. With Patna, Bengaluru and Pune 1,000 km from each
other the nearest centroid is never wrong; add a fourth city 150 km from an
existing one and it starts misfiling listings, silently, in a way that surfaces
as "my listing does not appear in its own city". Padded bboxes widen the
ambiguous strip further (D47).

**Chosen: `City.boundary`, tested with `ST_Covers`, falling back to the nearest
centroid with a logged warning.** `resolveCityForPoint` in `geo-queries.ts` is
the only place that decides, and it returns a `method` — `covers` or `nearest`
— which every caller logs. A `nearest` answer is a guess, and the point of
labelling it is that a systematically misfiled city shows up as a pattern in
the logs rather than as a support ticket.

**`ST_Covers`, not the `ST_Contains` the brief names.** `ST_Contains` is
geometry-only, so using it would mean casting the geography column and losing
the spheroidal semantics the rest of that file depends on. `ST_Covers` is the
geography-native equivalent and additionally treats a point exactly ON the
boundary as inside — which is the answer you want for an address on a
municipal border, and a case the tests cover explicitly.

**Sourcing the polygon: the local Nominatim, not `osmium` during bootstrap.**
Both were on the table. Extracting the `admin_level=8` relation with osmium
means relation assembly, multipolygon repair and a new step in a shell script;
querying the freshly-imported Nominatim once with `polygon_geojson=1` is a
fetch and a parse, and it reuses a service that now runs locally anyway — which
also means re-deriving costs nothing. `pnpm cities:boundaries` writes
`packages/shared/src/cities/boundaries.generated.ts`, and **the generated file
is committed**: same split as the seed photographs (D31), a live derivation step
and a committed artifact that is the real source of truth, so seeding needs no
service and every machine gets identical geometry.

The polygons are **simplified before being written** — Douglas-Peucker at
0.0005° (roughly 50 m), written out in the script rather than pulled in as a
dependency. A raw OSM city boundary is tens of thousands of points, and the
only question ever asked of it is containment, where metre-level fidelity buys
nothing and a megabyte of committed coordinates costs review and memory.

**The column is optional and the CHECK is about area, not presence**, and both
halves are deliberate:

- Optional for the reason every geography column here is: a REQUIRED
  `Unsupported()` field makes Prisma drop the model's `create` operation
  entirely (D15).
- `city_boundary_has_area` rather than a NOT NULL check, because a NOT NULL
  boundary would make `pnpm db:seed` fail on a clone that has never run
  `pnpm bootstrap` — and the core stack has to be usable before the geo profile
  exists (D6). Presence is enforced where it costs nothing: `cities:validate`
  warns per city and `/health/geo` reports it.
- The check is about **area** because that is the failure that is otherwise
  silent. `MULTIPOLYGON EMPTY` and a ring whose four points are collinear are
  both accepted by PostGIS, both store happily, and both then match nothing —
  every listing in that city quietly falls through to the centroid guess with
  the column looking populated. A point-count check, by contrast, can never
  fire: PostGIS refuses a ring with fewer than four points at parse time. A
  constraint that cannot fire is worse than none, because it reads as
  protection.

The GiST index is declared in `schema.prisma` (`city_boundary_gix`) like every
other spatial index, because Prisma introspects them and would otherwise emit a
DROP on the next `migrate dev` (D13).

**The client's `citySlug` is a hint, not the answer.** A wizard's city dropdown
and a map pin can disagree, and when they do the pin is the fact — so
`createDraft` resolves the city from the coordinates and uses the **resolved**
slug in the listing's URL slug too, because a listing whose URL says one city
and whose row says another is an inconsistency that surfaces months later as a
broken filter. A patch re-resolves whenever the pin moves, not only when the
dropdown changes: dragging a marker across a municipal border is exactly the
edit that would otherwise leave a listing filed under the wrong city.

Verified with 8 tests in `packages/db/test/city-assignment.test.ts` against real
PostGIS — a mocked client would assert nothing about `ST_Covers` on a column
Prisma cannot even SELECT. Two square boundaries 0.6° apart, and the strip
between them probed: a point inside resolves by `covers`; a point just inside
the far edge resolves to the containing city rather than the nearer centroid; a
point exactly on the boundary resolves (which `ST_Contains` would not); a point
in neither falls back and is labelled `nearest`; a city whose boundary is NULL
falls back too; overlapping polygons resolve to the smaller one; and both the
zero-area and the empty boundary are refused by the constraint.

### D51. Artifact staleness is detectable, and the download strategy switches itself

Two related holes, both of which fail the same way: everything reports healthy
and one city returns nothing.

**Staleness.** The manifest from D46 already carried the epoch and the source
checksums; it now also carries the full city list, both bounding boxes per city
and the download strategy. Three things read it:

- **The API, at boot.** It hashes the running city config and compares. A
  divergence is logged at `error` with the cities added or removed, because a
  stale artifact set is not untidiness — it is a configured city that will
  geocode and route to nowhere.
- **`GET /health/geo`**, which answers 503 on divergence. Deliberately **not**
  `/health`: `web` declares `depends_on: api: service_healthy`, so folding this
  in would stop the core stack coming up on a clone with no artifacts, which is
  the thing D6 exists to prevent. A fresh clone reports `unbuilt` here and 200
  there, which is exactly the truth.
- **`pnpm geo:status`**, which prints every artifact with its state and the
  exact command that rebuilds it — not "rebuild", the command. It detects three
  kinds of staleness three different ways, because the artifacts are three
  different kinds of thing:
  - files on disk (the city cuts, the merged extract) against the config's
    padded bboxes and the manifest's checksums;
  - the OSRM graphs, by reading the sha256 of the extract each was built from
    out of the named volume through a throwaway container — the same stamp
    `osrm-init` writes and compares, so a re-cut rebuilds instead of being
    skipped;
  - the Nominatim and Overpass imports, from a stamp `bootstrap.sh` writes
    **after** each service answers. Neither service can be asked which extract
    it holds, and both import on first boot only — so without the stamp the two
    artifacts most likely to be stale would be the two nothing could vouch for.
    Their fix is three commands rather than one, because re-importing means
    dropping a volume.

`geo:status` exits non-zero when anything is not `ok`, `unknown` included: an
artifact nobody can vouch for is not one to build on.

**The download strategy.** Below four Geofabrik zones, per-zone extracts are
smaller; at four they are not. The zones covering the seed cities are 236 MB
(eastern), 533 MB (southern) and 210 MB (western) — about 1 GB — against
roughly 1.4 GB for `india-latest.osm.pbf`, so the fourth zone is where the sum
crosses. `planDownloads()` picks automatically, because the arithmetic is not a
preference, and **logs which it picked and why**, because a silent switch from
three 200 MB files to one 1.4 GB file reads as a bug in a slow-network report.
`bootstrap.sh` prints it, the manifest records it, and `cities.ts extracts`
resolves each city's source file so the shell never has to know which strategy
is in force.

Past that point the binding constraint stops being download size and becomes
**OSRM graph RAM**: `osrm-extract` and `osrm-customize` hold their working set
in memory, and the whole-country extract needs far more than a laptop has, so
the answer beyond a handful of cities is a build host rather than a bigger
download. That is stated in `docs/adding-a-city.md` rather than left to be
discovered.

## Correction 9 — out-of-coverage is an explicit state

### D52. The coverage frontier is the union of the PADDED bboxes, read from the manifest

Coverage is one question — _is this a point we can answer anything about?_ — and
it has exactly one right answer boundary: the region the OSM artifacts were cut
from. That is the union of the **padded** boxes (D47), not the administrative
ones. An office 4 km outside Patna's administrative box is inside the extract,
has a road graph around it, and must work.

Two things about that union are easy to get wrong, and both are asserted in
tests rather than left to comments:

- **It is a union of rectangles, not the bounding rectangle of the union.** The
  bounding rectangle of Patna, Bengaluru and Pune covers most of India. Nagpur
  sits inside it and inside none of the three cities. Verified:
  `isInsideBbox(nagpur, bboxUnion([...]))` is `true` while
  `isInsideAnyBbox(nagpur, [...])` is `false`
  (`packages/shared/test/bbox.test.ts`), and `checkCoverage(nagpur)` returns
  `covered: false` against the real config (`apps/api/test/coverage.test.ts`).
  The rectangle is used for exactly one thing — the map's `maxBounds`, which
  only has to stop someone panning to Europe.
- **It comes from `osm-data/manifest.json`, not from `CITIES`.** The manifest
  records what `osmium extract` actually cut. A fourth city added to the config
  but not yet built is precisely the divergence D51 shouts about at boot; it
  must not also silently start claiming coverage of a city with no road graph,
  no geocoder index and no POI database. When there is no manifest at all — a
  clone that has never run `pnpm bootstrap` — the config's boxes are the
  fallback, because the core stack is usable in that state (D6) and refusing
  every point would break more than it protects.

The check is **one SQL statement** in `packages/db/src/geo-queries.ts`
(`resolveCoverage`), answering three things in one round trip: inside any padded
envelope, which boundary covers the point, and which centroid is nearest with
its distance. `ST_Collect(ARRAY[ST_MakeEnvelope(...), ...])` with every
coordinate a bound parameter; planar geometry rather than geography for the
envelope test, because a bbox test _is_ a degree-space rectangle test.
`ST_Covers` rather than the `ST_Contains` the brief names, for the reason
already recorded in D50.

### D53. Out of coverage is a 200 for a read and a 422 for a write

The same fact wants two different responses, and the split is not arbitrary.

**Reads answer 200 with a distinct shape.** "We do not serve that city yet" is a
complete, correct answer to a well-formed question, so it is not an error. But
it must be impossible to mistake for an empty result set, which is what it was:
a radius search around a Mumbai office returned `total: 0` and no error, a
manually-dropped pin produced no POIs and no route, and a user concluded the
product had no listings rather than that it did not reach them. So
`GET /api/listings/search` returns a **discriminated union** on `status`, not an
extra field — there is no `total: 0` sitting next to a coverage payload for a
caller to read by accident, and TypeScript refuses to touch `listings` without
checking `status` first. Asserted directly: the out-of-coverage response has no
`total` and no `listings` property at all.

**Writes are refused with a 422 that carries the served cities.** A listing at a
Mumbai coordinate used to be accepted and filed under Pune by the
nearest-centroid fallback — 120 km of "nearest". The row existed, was invisible
in every search anyone would run for it, and looked perfectly healthy in the
database. The test asserts the refusal and `prisma.listing.count() === 0`,
because the point is the absence of the row. The error body carries the
`coverage` payload rather than only an English sentence, so the wizard renders
the supported cities as one-tap actions instead of regexing a city list out of
prose. It is the only error in the API that carries a payload; generalising that
is a decision for the second one.

**Nearest-centroid keeps working inside coverage.** This is the whole correction
in one line: for a point in a gap between a municipal polygon and the edge of
the extract, nearest centroid is the right answer and stays — labelled `nearest`
and logged, so a boundary that needs re-deriving shows up as a pattern (D50).
Across the coverage frontier the identical arithmetic is silent data corruption.
Both halves are tested against the real config.

### D54. "Degraded" and "out of coverage" are separate autocomplete states, because they were the same bug

`suggestPlaces` reported `degraded: remote.length === 0`. That conflated two
opposite conditions: Nominatim being down, and Nominatim correctly answering
that Mumbai is not in a three-city extract. A user searching an uncovered city
was told "the wider search is unavailable" — which invites a retry that can
never work.

The fix is at the adapter, not at the call site. `GeocodeProvider.search` now
returns `{ results, refused }`: `refused: true` for a failure, timeout, rate
limit or abort; `refused: false` with an empty list for a real empty answer. The
service then has three mutually exclusive states in **one enum field** rather
than two booleans, so the UI cannot render two messages or the wrong one:

| state             | meaning                                                   | what the UI says                      |
| ----------------- | --------------------------------------------------------- | ------------------------------------- |
| `ok`              | the list is the answer, empty or not                      | the list, or "nothing matched"        |
| `degraded`        | tier 2 was needed and could not answer                    | "showing local matches only"          |
| `out_of_coverage` | both tiers answered, both empty, query reads like a place | the coverage message and city buttons |

An aborted request counts as `refused`, deliberately: an abandoned keystroke
must not produce a coverage message for a query that was never actually asked.

**How often the third state actually fires, measured against the local
Nominatim rather than assumed.** Much less often than "search Mumbai"
suggests, because Indian city names are everywhere in the covered extracts as
road and business names: `mumbai` returns 7 results (top: Old Pune-Mumbai
Highway), `chennai` 6 (Bengaluru - Chennai Expressway), `hyderabad` 8 (Ancient
Hyderabad), `jaipur` 2, `kolkata` 1. Of the uncovered metros tried, only
`ahmedabad` came back `out_of_coverage`.

Those `ok` answers are correct rather than a hole in the feature: the matches
are real features inside coverage, and their context lines say "Pune" or
"Bengaluru", so someone who typed "mumbai" and is offered a Pune highway can
see what happened. It does mean the coverage message's real home is the
**coordinate** paths — a dropped pin, a shared URL, a saved office, a listing
create — which is where an out-of-coverage point did actual damage. The
autocomplete state is a genuine case and a narrower one, and saying so here is
better than leaving the Mumbai example to imply otherwise.

The place-name gate is crude on purpose — a word of three or more characters and
at most a quarter digits. The cost of a false positive is one extra sentence in
a dropdown, so the tests pin both sides of it, including that "zzzqqq" does get
the coverage message. One real bug came out of writing them: `\p{L}{3,}` rejects
"कोलकाता", because Indic vowel signs are `\p{Mn}` rather than letters, so the
longest run of pure letters in it is two. A heuristic that silently excluded
every Devanagari and Kannada query from the coverage message would have failed
exactly the users this product is for; the pattern is now
`\p{L}[\p{L}\p{M}]{2,}`.

### D55. `CoverageRequest` is the point of the out-of-coverage state, not decoration

A refusal with a next action is worth building; a dead end is not. The table
holds an email, the requested coordinates and the resolved place label if there
was one, and it is the real signal for which city to add fourth.

Three details keep that signal honest:

- **Coordinates are rounded to 3 dp (about 110 m) before storage, and the unique
  constraint is on the rounded pair.** One person tapping "tell me" on three
  slightly different pins is otherwise three rows, and the count that decides
  the fourth city becomes a count of taps. Repeat asks increment `asks` instead.
- **The count reported back is spatial, not exact-match**: distinct emails
  within 50 km (`COVERAGE_REQUEST_CLUSTER_METERS`). Two people asking for Mumbai
  will not have dropped pins on the same building, and Thane and Colaba are
  40 km apart. Verified: a second ask from the same person leaves the count at 1;
  an ask from a different person 30 km away takes it to 2.
- **A request for a covered point is a 409.** A row here is a vote for a new
  city, and votes for cities that already exist would quietly poison the one
  number the table is for.

It carries a geography column and a GiST index like every other geo model, and
its `location` comes from the same `machiya_sync_location` trigger (D2). That is
not reflex: "which city next" is a spatial clustering question, and forty
requests spread across Maharashtra are not the same signal as forty within 20 km
of Nariman Point.

The endpoint sends no mail. It is an unauthenticated write with an email address
in it — the shape of thing that gets used as a mail relay — so it is rate
limited to 10 per hour per IP, an order of magnitude harder than the rest of the
API, before it ever does.

### D56. `maxBounds` is the cheapest fix in this correction, so it is applied first

Most of the confusion never has to be explained. The map is bounded to the
coverage rectangle from the first paint, so panning to a city the product does
not serve is never offered, and the initial camera sits on a covered city. Both
come from `GET /api/coverage` rather than from a build-time constant, which is
what makes correction 8's "adding a city is one record" claim true of the
frontend too — and is why `VITE_DEFAULT_CITY` is now deleted. It named a city the
deployment might not cover, and it was read in exactly one place that now reads
the served set instead.

`maxBounds` is set imperatively through `map.setMaxBounds()` in an effect, not as
a `<Map maxBounds>` prop. The value arrives from an async fetch, and handing
react-map-gl a changing bounds prop makes it re-derive view state on a component
that is otherwise camera-authoritative — the same reason the camera itself is
animated with the map's own `fitBounds` rather than from React state.

### D57. The API was pointed at the PUBLIC Nominatim, which 403s the placeholder contact

Found while verifying correction 9 against the running stack rather than
against the tests, which stub tier 2 and therefore could never have caught it.

`.env` carried `NOMINATIM_URL=https://nominatim.openstreetmap.org`. The public
instance rejects `Machiya/0.1 (contact@example.com)` — the placeholder the file
itself tells you to replace — with a flat **403 on every `/search` and
`/reverse`**. Exactly what was observed:

```
WARN: nominatim search failed
  "message": "nominatim 403 for /search"
```

Which then degraded silently, because degrading silently is what the adapter is
built to do: tier 2 refused, the endpoint fell back to tier 1, and every
landmark query in development returned an empty dropdown. `/health/geo` was
green throughout — it checks the artifacts, not whether the API can reach the
service that reads them.

Three things came out of it, and none of them is the 403:

- **`.env` now points at `http://localhost:7070`**, the local instance from the
  `geo` profile, matching `.env.example` and compose. A public endpoint is a
  fallback, never a default — this was the default.
- **`PUBLIC_NOMINATIM_URL` is deleted from `.env.example`.** It was declared
  there and read by nothing: the adapter only ever reads `NOMINATIM_URL`. Same
  dead knob, same reasoning, and same fix as the `ALLOW_PUBLIC_OSRM` pair.
- **Every geo claim in this session was re-verified against the local instance
  afterwards.** The first round of measurements was taken against a 403ing
  upstream and was worthless; two of them are in D54's table and would have
  been recorded as fact.

The operational lesson is smaller but cost more time: **two `pnpm dev:api`
processes were running**, and the stale one held port 4000 while the fresh one's
log looked healthy. Its 403s went to a log file that had already been deleted,
so the symptom was a route that returned `degraded` with nothing logged
anywhere. Check what owns the port before believing a log.

## Correction 10 — honest expectations about address precision

### D58. Tier 1's fuzzy search already degrades an address; only tier 2 needs a strip

The correction assumed a house-number strip was needed to turn a dead-end
address into a useful area. Measuring first showed that is only half true, and
the half it is wrong about is the expensive half.

**Tier 1 needs no strip.** `pg_trgm` similarity over the `Locality` table is
already a fuzzy search, and against the seeded database it degrades a full
street address to its locality unaided:

| Query                                     | Tier 1's top row        |
| ----------------------------------------- | ----------------------- |
| `House 47, Road 3, Rajendra Nagar, Patna` | Rajendra Nagar, 0.42    |
| `Flat 4B, 21 Patliputra Colony, Patna`    | Patliputra Colony, 0.56 |
| `Lane 5, Kothrud, Pune`                   | Kothrud, 0.42           |

So a pre-stripped second local query was deleted from the service: it was a
slower way to reach the row trigram had already found. The first version of this
correction had one, and it went before it was committed.

**Tier 2 does need it, and free text alone is not enough.** Nominatim answers
nothing for `House 12, Anisabad, Patna` and returns the neighbourhood for
`Anisabad, Patna`; nothing for `Flat 3, Bailey Road, Patna` and the road for
`Bailey Road, Patna`. The obvious fuzzier alternative — drop the commas so
Nominatim stops parsing structurally and matches free text — was tested and is
**not** the fix: eight of ten addresses returned nothing with or without commas,
so those strings are genuinely absent from the extract rather than mis-parsed.
It is worth doing anyway, because it never did worse and once did much better
(`#118, 5th Block, Koramangala` returns a **hotel** with commas and
`Koramangala 5th Block` without them), so the adapter now sends free text _and_
retries once with the house number stripped.

Three rules keep the retry from becoming a guess:

- **Strip conservatively.** A leading bare number, a number with a letter
  suffix, or a House/H.No/Flat/Plot/Door/No/# prefix followed by one. "Road 3"
  and "5th Block" are road and block names and survive.
- **One retry, never a loop.** Truncating until Nominatim bites is what turns a
  bad query into a confidently wrong answer: strip past the house number on
  `47 Road 3 Rajendra Nagar Patna` and all eight results are wrong roads, led by
  `90 Feet Road`, which is real and is not the one asked for.
- **Cap the retry at `locality` precision.** The house number is gone, so even a
  building hit is not the building that was asked about. This is the single rule
  that separates "a labelled guess" from "a confident lie".

The outcome is cached under the normalised **original** query, retry included, so
a dead-end address costs two upstream calls once rather than twice per keystroke.

**One ranking bug came out of the measurement.** For the long address forms,
listing rows scored level with the locality and sometimes above it — so an
address search would have set the office to one specific flat rather than to the
neighbourhood. Listings are now weighted 0.35 instead of 0.8 when the query
reads as a street address, keyed on the same house-number signal.

**And one real bug in the adapter.** Nominatim's jsonv2 output renamed `class`
to `category`; the schema read only `class`, which is optional, so every result
fell through to the `poi` branch — a suburb was being classified as a shop.
Both are read now, and the local instance answers with `category`.

### D59. What the geocoder did is said out loud, and the box asks for what the data has

`matchPrecision` is `exact`, `locality` or `area`, derived from what the result
**is** rather than from how it was found — a `place/suburb` hit is a
neighbourhood whether it came from the original query or the retry. A **road** is
`locality`, not `exact`: finding Bailey Road for "Flat 3, Bailey Road" means we
found the street and not the flat, and calling that exact would promise a
precision the answer does not have.

`exact` renders **no note at all**. A precise answer is the good case, and a
product that annotates its successes trains people to distrust them — the same
reason a locally-answered query reports `ok` rather than something apologetic.

The copy follows from the numbers. Of ten real addresses with house numbers
across the three cities, five returned nothing and **one** resolved to an actual
`addr:housenumber` — the wrong one, on a café. So the field reads "Search a
landmark, locality or area near your office", never "Enter your address": the
second promises precision the data cannot deliver and makes a working product
feel broken. A one-line hint on first focus says landmarks and localities work
best and that dropping a pin is the precise option.

Kept proportionate on purpose. This sets an **office**. Offices sit in
commercial areas with named buildings and landmarks, and being 200 m out changes
nothing about which listings fall inside a 1/2/3 km ring — so the note is one
quiet line, not a warning.

**What is deferred, and why it is not silent.** The correction also asks that the
lister wizard prefill only the locality when reverse geocode returns a
locality-level match, leave the street line empty and editable, and refuse to
complete its location step without a placed pin. The wizard does not exist yet —
it is brief step 9 — so those three rules are implemented there rather than
invented against a component that has no callers. The pieces they need are in
place: `reverse` now returns a derived `matchPrecision`, and measured at Golghar
it comes back as "Patna" rather than the building, which is exactly the case the
rule exists for.

### D60. Three bugs the live run found that the tests could not

All three were invisible to the test suite because the suite stubs tier 2 —
which is the right thing for it to do, and the reason a live pass is not
optional. Each is now covered by a test as well.

**1. Weak local rows suppressed the tier that had the answer.** Tier 2 ran only
when tier 1 returned fewer than five rows, counted flat. "Flat 3, Bailey Road,
Patna" returned **eight** listing rows at similarity 0.117 — every flat in
Boring Road, which shares trigrams with Bailey Road — cleared the count of five,
and so Nominatim, which knows Bailey Road perfectly well, was never asked. The
user got eight unrelated flats instead of their street.

Sufficiency is now judged on _confident_ rows: a place row counts at any score,
because a weak trigram hit on a locality name is still that locality, but a
**listing** row has to clear `AUTOCOMPLETE_CONFIDENT_SCORE` (0.4). Eight weak
matches are not an answer to a place query.

**2. The two tiers' scores were not comparable at the low end, though the code
said they were.** Nominatim's `importance` clusters very low — an ordinary
residential road is around 0.053, Bailey Road is exactly 0.0533 — and the old
mapping floored at 0.1, _below_ trigram noise. So even once tier 2 was reached,
the road still lost to the flats.

The first fix was a hard floor at 0.25, and it introduced a second problem worth
recording because it is the more interesting one: **clipping flattens the range
where almost everything lands.** Six Bailey Roads and a suburb all pinned to
0.25 left the alphabetical tiebreak choosing the winner, and it chose "Ahmed
Enclave" over "Anisabad" for a query that said Anisabad. So the range is
**lifted** rather than clipped — 0.25 to 0.90, monotonic — plus a small bonus
for anything OSM itself categorises as a `place`, which is what puts Anisabad
Golamber above a children's park that merely sits in Anisabad.

**3. An unresolvable address in a covered city was answered with the coverage
message.** "221 Sarjapur Road, Bellandur, Bengaluru" resolves to nothing —
Bellandur is not one of our `Locality` rows and Nominatim has no match for that
string — and `looksLikePlaceName` was happy to call it a place name, so the
reply was "Machiya covers Patna, Bengaluru and Pune." For an address **in**
Bengaluru that is a non-sequitur, and exactly the confusion the coverage state
was built to remove.

The out-of-coverage state now additionally requires that the query does _not_
read as a street address. That is the line between the two corrections, stated
as code: an address we cannot resolve is an address problem and gets the address
message; a place name we cannot resolve anywhere is a coverage problem and gets
the coverage message.

**And one thing that was not a bug.** Two verification commands lied before this
was believed. `redis-cli --scan --pattern '*geocode*' | xargs -r redis-cli del`
deletes nothing: the keys contain the query text, so they contain **spaces**,
and `xargs` splits each key into several arguments. It exits zero. A stale cache
then made a corrected score look uncorrected, which sent a diagnosis after
already-fixed code. The working form is
`... | while IFS= read -r k; do redis-cli del "$k"; done`. The other was two
`pnpm dev:api` processes, covered in D57.

## Step 8 — the commute cost engine

These four entries were **written after the fact**, in brief step 9, and that is
itself the finding. Step 8 shipped with `D61`-`D64` cited in five source files —
`apps/api/src/geo/osrm.ts`, `packages/shared/src/cities/fuel-sources.ts`,
`apps/worker/src/fuel/index.ts`, `packages/db/prisma/schema.prisma` and
`packages/shared/src/listing.ts` — and no such entries existed here. A pointer
to a decision nobody wrote is worse than no pointer: it tells the reader the
reasoning is recorded and sends them to an empty page.

They are reconstructed from the shipped code and from the measurements the code
itself records. Where a number below could not be re-measured in the session
that wrote the entry, it says so rather than restating a comment as fact.

### D61. One `/table` call prices a whole page of listings — and the `--max-table-size` pin does not bound it

Sorting by total monthly cost (D64) needs a road distance for **every candidate
in the radius**, not for the page being shown. One `/route` per listing would be
200 sequential round trips per search, so the road distances come from a single
`/table?sources=0` — one origin, every destination, one request — in
`apps/api/src/geo/osrm.ts`.

Step 8 recorded that `--max-table-size 1000` was declared on both OSRM services
"rather than inherited, because this is the call that depends on it", and that a
default below the candidate count would degrade the total-cost sort silently.
**That is wrong, and this entry exists mostly to say so**, because the shape of
the mistake is the one this project keeps finding: a knob that looks configured
and is not (D26's flatnode file, D57's `PUBLIC_NOMINATIM_URL`).

Measured against `osrm/osrm-backend:v5.25.0`, by starting a second instance on
the project's own graph volume with `--max-table-size 10` and probing the
boundary:

| Request shape                           | Coordinates | Result                                    |
| --------------------------------------- | ----------- | ----------------------------------------- |
| all-to-all (`/table` with no `sources`) | 4           | `Ok 4x4`                                  |
| all-to-all                              | 11          | **HTTP 400 "Too many table coordinates"** |
| `sources=0`                             | 11          | `Ok 1x11`                                 |
| `sources=0`                             | 12          | `Ok 1x12`                                 |

So the limit is enforced **only for the all-to-all shape**. Given an explicit
`sources`, v5.25 checks `sources.size() * destinations.size()`, and with
`destinations` unset that product is zero — it can never exceed any limit. The
production pin was confirmed to be equally inert: against the real `osrm-car`
with its `--max-table-size 1000`, a `sources=0` request with 2,000 destinations
answered `Ok 1x2001`, and 200 coordinates all-to-all (40,000 pairs) answered
`Ok 200x200`.

Two things follow:

- **`TABLE_CHUNK = 200` in the adapter is the only bound that actually
  exists.** It was recorded as "cheap insurance" against a hypothetical proxy
  objecting to a 24 KB URL. It is not insurance; it is the limit. The chunk
  results concatenate exactly, so chunking cannot change an answer, and the
  comment at the constant now says what it is really doing.
- **The compose flag stays anyway, with its comment corrected.** It costs
  nothing, it is the right value if an all-to-all `/table` is ever added, and
  removing it would mean re-deriving this measurement the next time somebody
  wonders. What it must not do is keep claiming to protect a call it does not
  reach.

The performance numbers were re-measured at the same time, and the step-8
figure was optimistic: a 300-destination `sources=0` request against `osrm-car`
takes about 970 ms cold and 230-290 ms warm, not 170 ms. 1,000 destinations
answer in about 840 ms warm. Still one round trip per search rather than two
hundred, which is the point — but the honest number is a quarter of a second,
not a sixth.

### D62. Three fuel sources, two of them one feed, and every quote checked against the city the page names

The brief named a set of fuel-price sources. Checking them against the live
sites replaced most of it, and the checking matters more than the replacements.

**Two originally configured sources were removed because they cannot work.**
`mypetrolprice` serves the Delhi shell for every city slug — HTTP 200, a
perfectly plausible price, the wrong city. And on `goodreturns`' Patna page a
ticker carries the **national** petrol figure (111.31) next to Patna's real one
(113.37), so a parser that takes the first price on the page is wrong by two
rupees a litre with nothing on the page to indicate it.

Neither failure is catchable by a plausibility band, because both numbers are
plausible fuel prices. **The only defence is refusing a number the page does not
itself attach to this city**, which is what `cityNameVariants` and `buildQuote`
in `apps/worker/src/fuel/adapter.ts` exist for. Bengaluru carries both
spellings, because every source indexes it as `bangalore` while the page text
sometimes says Bengaluru — which is also why the per-source slug lives in the
city record (D49) rather than being derived from the city slug.

**What survived: `goodreturns`, `bankbazaar` and `petrolpriceindia` — but that
is two feeds, not three.** `bankbazaar` and `petrolpriceindia` returned
identical figures where `goodreturns` differed (Bengaluru diesel: 98.8 from both
against 99.56), so they are one upstream behind two front doors. The registry
records that as `sharesFeedWith`, and it is not decoration: `pickConsensus`
takes a median, and without collapsing the shared pair into one vote the shared
feed outvotes the independent one on every fuel, every hour, invisibly. They
still earn their place for **availability** — either site can be down alone —
which is a different thing from verification, and the registry says so in those
words.

`independentFeedCount` is the number that answers "would we notice if this price
were wrong", and the admin scrape-health page reports it rather than a source
count.

**A median, with a real quote kept alongside it.** The served price is the
median of what answered; the `source` and `sourceUrl` of one actual quote are
kept, so attribution still points at a page a person can open. A median with no
provenance is a number nobody can check.

**Nothing in the scrape can fail the run.** Source failure is the normal case
here, not the exception: adapters are asked in series per city — 27 requests
fired at once is a burst on somebody else's server for no gain when the job has
a whole hour — each failure is recorded as per-adapter health, and the job
throws only if Redis and Postgres are both unusable. An adapter that has
returned nothing for `FUEL_ADAPTER_DEAD_AFTER_RUNS` consecutive runs is reported
dead, because the interesting failure is one source dying quietly while the
others cover for it — exactly the failure a "did the job succeed" check cannot
see.

### D63. Commute preferences are one JSON column, parsed on the way out as well as in

`User.commutePrefs` holds fuel type, vehicle class, mileage, trips per day and
working days per month, as a `Json` column rather than five typed columns or a
side table.

The test for that shape is whether anything ever **queries or aggregates** the
fields, and nothing does: they are read whole for one user and written whole by
one form. Five columns would buy indexes nobody uses and a migration every time
the commute engine gains a knob.

Two rules keep the column from becoming the usual JSON-blob liability:

- **It is parsed with `commutePreferencesSchema` on the way out, not cast.** A
  blob written by an older shape is a real possibility on any long-lived row,
  and a missing `mileageKmPerLitre` would otherwise reach the engine as
  `undefined` and produce `NaN` rupees — a number that _renders_, which is the
  worst kind of wrong. A blob that fails the parse is logged with the offending
  paths and replaced by the defaults for that request.
- **Updates are read-modify-write and validated as a whole**, not a JSON merge
  in SQL, because the merged result is what has to make sense: `mode: 'bike'`
  with a car's mileage is two individually valid fields and one nonsensical
  setting. Changing vehicle class clears a pinned mileage unless the same patch
  sets one — otherwise picking "SUV" silently keeps the hatchback's 15 km/l and
  understates the commute, which is the one error this product must not make.

**Null means "never touched", and that is different from "set to the
defaults".** The panel says which, because a default the user has never seen is
not a preference they have expressed.

### D64. `total_cost` is an expression inside the search query, never a re-sort of a page

Rent plus maintenance plus the real monthly commute, ranked ascending, computed
in the same statement as the search.

The alternative — fetch a page and sort it in the client — is not a smaller
version of this feature, it is a different and wrong one. It would show the
cheapest of the 24 listings that happened to be on screen rather than the
cheapest of the 200 in the radius, and the listing whose rent looks high until
you price the commute is _by construction_ the one a page-local sort buries.
That inversion is the product's entire argument, so the sort has to see every
candidate.

Consequences, each of them deliberate:

- **The road distances are joined in.** `roadDistanceJoin` builds a VALUES join
  from the `/table` answer (D61), so the cost is an expression over columns
  rather than a lookup per row. The moment one input needed a per-row fetch, the
  sort would have to leave SQL.
- **The commute parameters are supplied by the API, never by the client.** They
  come from the caller's stored preferences (D63), the scraped fuel price and
  the city's fare table. A client that names the fuel price its own commute is
  costed with is a client that can rank itself first.
- **Both halves or neither.** The cost columns exist only when the caller
  supplied parameters _and_ distances; either alone would produce a number from
  a missing input, which is worse than no number. Without them
  `sort=total_cost` is a programming error and throws, rather than quietly
  falling back to distance — a sort control that silently sorts by something
  else is the failure this entry exists to prevent.
- **A sale listing's total is NULL, not zero.** A monthly total for a purchase
  needs an interest rate this product never asks for. `ORDER BY` sends the NULLs
  last rather than treating them as free.

Keyset pagination still applies (D19), so the ranking is correct **across
pages** — which a page-local sort cannot be, even in principle.

## Correction 11 — the typecheck gate

### D65. `pnpm typecheck` did not look at a single test file

CLAUDE.md calls `pnpm typecheck` a hard gate that "exits 0 across every
package". It did — while never compiling a line of test code. Every package's
`tsconfig.json` includes only `src/**/*.ts`, so `test/` was outside all of them,
exactly the gap `tsconfig.tools.json` was created to close for root-level
scripts.

Found because two type errors were visible in an editor and invisible to the
gate. Adding a `tsconfig.test.json` per package immediately surfaced five real
errors, and **every one of them was introduced by this session's own work**:

- `computeCommuteCost`'s parameter was typed `z.infer` (the parsed output)
  instead of `z.input`, making `roadDurationSeconds`'s default unreachable and
  forcing five call sites to pass a field the schema exists to fill in. Fixed at
  the source with the `CommuteCostInput` / `CommuteCostOptions` split the repo
  already uses for `ListingSearchInput`.
- a stubbed `RoutingProvider` in `listing-detail.test.ts` was missing `table`
  after correction 8 added it to the interface.
- the `remote()` fixture in `places.test.ts` predated `matchPrecision`.
- eighteen errors in `search.test.ts` from reading `listings` and `total` off the
  discriminated union correction 9 introduced, without checking `status`.

That last one is the one worth dwelling on. Those reads only worked because the
`ok` arm happens to carry the same field names — so a test that received an
out-of-coverage response would have read it as an empty result set, asserting
precisely the confusion the union exists to prevent. They are now narrowed
through an `ok()` helper that throws on the wrong arm.

Two smaller notes. `rootDir` is widened to `.` in the test configs rather than
moving tests under `src/`: it is inherited, it points at `./src`, and it is
meaningless under `noEmit` — moving real files to satisfy a setting nothing
emits from would be the wrong way round. And the configs are per-package rather
than one at the root, because the packages differ in `types` and module
resolution and a single config would have to flatten that.

### D66. Two tests that could not fail

Both found while fixing the type errors above, and both worse than the type
errors.

**The animated-image rejection asserted nothing.** It built its fixture with
`sharp(buffer, { pages: 3, pageHeight: 64 })` — but `pageHeight` is not a
`SharpOptions` field (it lives on `CreateRaw` and `Metadata`), so it was
ignored, the image had one page, and the assertion sat behind
`if ((meta.pages ?? 1) > 1)` and never ran. Verified: both that form and a
`raw` + `pageHeight` form produce `pages: 1`.

sharp cannot be persuaded to write a multi-page image from a tall single-page
buffer, so the fixture is now a committed 200-byte two-frame animated **WebP**,
built once from a hand-assembled 2-frame GIF89a. WebP specifically: an animated
GIF is rejected for its _format_ before the animation check is ever reached, so
it would have passed the test for the wrong reason — which the first attempt at
this fix did, and the error message said so.

**The EXIF strip test stripped nothing.** It set `GPS: { GPSLatitudeRef: 'N',
... }`, and `GPS` is not a key in sharp's `Exif` type — only `IFD0` to `IFD3`.
The key was silently ignored, so the test asserted that an image with **no
location data** came out with none. `IFD3` is the GPS directory, and measured, it
takes the EXIF block from 230 to 272 bytes. The test now asserts its own premise
(`before.exif` is defined) before asserting the strip, so a future sharp that
stopped writing EXIF here cannot make the strip look like it worked.

That test also claimed to prove orientation handling — "a 400x200 source must
come out 200x400, proving the rotation was applied". It never checked the
dimensions, and could not have: sharp normalises orientation to 1 when it
writes, whichever directory the tag goes in, so `withExif` cannot produce a
non-1 orientation at all. Measured for `IFD0` and `IFD1`, both come back as 1,
and `.rotate()` leaves 400x200 unchanged. Testing it properly needs a fixture
carrying a real orientation tag, which means committing binary image data —
left undone deliberately, and recorded in the test as undone rather than left
looking finished.

## Step 9 — the lister side

### D67. A draft is incomplete in the database, not padded with placeholders

The wizard autosaves after every step, starting with location. That means a row
has to exist after step one — a pin, a city, nothing else — and
`listingDraftSchema` describes a **complete** listing: a title of at least eight
characters, a thirty-character description, a carpet area, a furnishing level.
Nothing in that shape can be written from a dropped pin.

Three ways out were on the table:

1. **Keep the columns NOT NULL and write placeholders** — `title: ''`,
   `areaSqft: 0`. Rejected. An empty title is a value every reader downstream
   then has to disbelieve, and a zero area is a number that renders. It is the
   same failure as a `NaN` monthly cost in D63: wrong in a way that looks like
   data rather than like a bug. It also makes "is this draft finished" a
   question about sentinel values, which every call site has to answer the same
   way and one eventually will not.
2. **Keep the row out of the database until it is complete** and autosave to
   browser storage. Rejected by the requirement: a draft has to survive a closed
   tab **and a different device**, which local storage cannot do.
3. **Make the columns nullable and enforce completeness at the boundary the
   listing actually crosses** — chosen.

So `title`, `description`, `address`, `locality`, `propertyType`, `furnishing`,
`bedrooms`, `bathrooms` and `areaSqft` are nullable, and the
`listing_complete_when_live` CHECK makes every one of them NOT NULL the moment
`status` leaves `DRAFT`. The constraint also carries the price rule — a live
RENT listing has a `rentAmount`, a live SALE listing has a `salePrice` — because
a published rental with no rent is not a validation failure, it is a row that
makes every price sort and every total-cost sort wrong.

Verified by trying it: inserting a bare `PUBLISHED` row is refused with
`new row for relation "Listing" violates check constraint
"listing_complete_when_live"`, the identical row inserts fine as `DRAFT`, and
`UPDATE ... SET status='PUBLISHED'` on that draft is refused. `prisma migrate
status` then reports "Database schema is up to date!" — Prisma has no CHECK
support, so it ignores the constraint and sees no drift, the same arrangement as
`listing_location_present` (D15) and `city_boundary_has_area` (D50).

**`listingType` is defaulted rather than nullable.** A two-value enum has no
honest null, this is a rentals product, and the wizard's second step shows the
real choice. Defaulting it costs one enum default; making it nullable would cost
another CHECK clause and another null every consumer has to narrow.

Four things fell out of the change, and each is the interesting part:

- **The publish error had to be rewritten.** Feeding a null title to
  `publishableListingSchema` produces "expected string, received null", which
  tells a lister nothing. `missingPublishFields` runs first and answers _which
  field, on which step, in words_; the strict schema then answers the question it
  is actually good at — whether the combination is coherent (a rent on a sale, a
  third floor in a two-storey building). Two checks, each doing one job.
- **The slug is claimed at publish, once.** A draft opened from a pin has no
  title to be named from, so it gets `draft-{city}-{suffix}` — obviously a
  placeholder to anyone reading the database. `changeStatus` renames it from the
  final title **only** while `publishedAt` is null and the slug still carries the
  draft prefix. After that the URL is frozen for good, because a slug that moves
  under a shared link is a broken link, whatever the listing was later renamed
  to. This is strictly better than the old behaviour, which froze the slug at
  _create_ time — so a wizard user who changed their title in step two got a URL
  naming the title they abandoned.
- **`listingPatchSchema` had to learn the difference between `undefined` and
  `null`.** A `.partial()` alone cannot express "the user emptied this box" —
  only "this step did not touch it" — so a title typed and then deleted would
  stay in the draft forever. The nullable fields accept both, and `toColumnData`
  passes `null` through rather than skipping it.
- **One test changed meaning rather than being deleted.** `search.test.ts`
  published a rental with a null rent to prove nulls sort last. That row can no
  longer exist, so the case now asserts the constraint refuses it — and the
  `COALESCE` in `price_asc` is documented as defence in depth rather than a live
  path. Deleting the test would have quietly removed the only evidence of why
  the old behaviour went away.

`publishableListingSchema` itself is unchanged, and D33 still holds: drafts
validate loosely, publishing validates strictly. What changed is that "loosely"
now includes "not yet present", which is what a wizard actually produces.

One thing the same change fixed by accident: publishing used to validate a
candidate built with `amenitySlugs: []` rather than the listing's real
amenities. Nothing in the strict schema reads them, so it changed no outcome —
but handing a validator a value that is not true is how a future rule gets
written against a lie.

### D68. "First message in a thread" is not the rule people expect, and the message row is its own outbox

Two decisions, and they are separate.

**When a notification is owed.** The brief asks for an email on the first
message in a thread and not on every message, which is right about the failure
it is avoiding — a lister who replies four times in ten minutes must not send
the seeker four emails — and wrong about the rule. Taken literally, a thread
that goes quiet for a week and then resumes sends nothing at all, and the person
who was waiting learns about it only if they happen to open the site.

So the rule is **first message in a while**: a mail is owed when the thread has
no previous message, or when the previous message is older than
`ENQUIRY_NOTIFY_QUIET_HOURS` (24). One boundary, one constant, and it is a
property of the conversation rather than of the recipient — so it needs no
per-user state and no "have we emailed this person lately" table.

The email says the rule out loud, in two lines at the bottom, because somebody
who gets one mail for a four-message exchange will otherwise conclude the
notifications are broken.

`notificationIsOwed(previousMessageAt, now)` is a pure function and is tested on
both sides of the boundary, including the one-minute-inside case.

**Whether a lost notification is worth reconciling.** D40 left this open —
"the enqueue-after-commit and reconcile pattern applies if a lost notification
matters; decide whether it does". It does, and more than a lost image job did:

- an enquiry notification is the supply side's **only** signal that a seeker is
  waiting, and nothing else in the product surfaces it;
- nobody can tell it was lost. A dropped image job shows its owner a spinner
  that never resolves; a dropped notification is invisible to the sender, the
  recipient and the operator alike. Unfalsifiable, which D48 already names as
  the worst property a failure can have;
- it is not retried by anything else. The seeker will not send the same message
  twice on the off-chance.

**No outbox table**, for exactly the reason D40 gives. `EnquiryMessage` is
already the durable record of intent; what it lacked was somewhere to record
that a mail was owed and whether it was sent. Three columns —
`notifyOwed`, `notifiedAt`, `notifyFails` — and the job id is the message id, so
enqueueing is idempotent by construction and a reconciler racing the original
enqueue collapses onto one job rather than sending twice.

`notifyOwed` is the column that earns its place. Without it, "this message never
needed a mail" (a reply inside an active conversation) and "this message needed
one and never got it" look identical, and the reconciler would either email
every chatty reply or nothing at all.

The rest is D40's shape, deliberately: enqueue strictly after the commit, a
failed enqueue logged and swallowed rather than failing the sender's request, a
two-minute grace period so the reconciler does not race an enqueue in flight,
and the finished-job corpse removed before its id is reused — because BullMQ
keeps completed jobs and `add` with an existing id is a **silent no-op**, which
would strand the row permanently.

Two differences from the image reconciler, both deliberate:

- **Two minutes rather than one.** The image reconciler's interval is set by how
  long a user will stare at a spinner. Nobody is watching this one, so the scan
  can be cheaper.
- **The worker's mailer throws where the API's swallows.** A failed verification
  email must not fail the sign-up that triggered it, so
  `apps/api/src/lib/mailer.ts` returns `{ sent: false }` and logs. Here the send
  IS the job, so it throws and BullMQ backs off; after
  `ENQUIRY_NOTIFY_MAX_ATTEMPTS` the row stops being owed a mail, because a row
  the reconciler picks up every run and cannot deliver is a loop rather than a
  safety net.

**Verified against the real stack, not only the suite.** A message was inserted
straight into Postgres with `notifyOwed: true` and no job enqueued for it — the
exact hole this exists to close — and the running worker's reconciler picked it
up and delivered it to MailHog **110 seconds later**, addressed to
`lister@dev.local`, subject "New enquiry about 1 BHK apartment in Boring Road",
with `notifiedAt` stamped on the row afterwards. Seven tests in
`apps/worker/test/reconcile-notifications.test.ts` cover the rest against real
Postgres and real Redis, including the finished-job case, which asserts its own
premise first: it adds a duplicate job under a completed id and checks the add
was a no-op before asserting the reconciler gets past it.

### D69. The owner's number is revealed by the conversation, not by a button

"Masked until an enquiry is sent" has three plausible readings and only one of
them is worth building.

Not **"until you sign in"**: a signed-in stranger is still a stranger, and it
would make every listing page a scrape target for anyone with an account.

Not **a reveal button** that shows the number after a click and calls the click
an enquiry. That is a mask in appearance only — the number is already in the
response — and a client that never renders the button still has it.

**Chosen: the number is absent from the payload until a thread exists between
these two people, and the server decides.** `viewerHasEnquiry` is the single
question the listing read asks, and the phone field is `null` for everyone else,
including a signed-in reader looking at somebody else's conversation. A client
cannot leak what it was never sent.

Three consequences worth stating:

- **It re-masks.** The check requires an `OPEN` or `RESPONDED` thread, so a
  lister who marks a conversation `SPAM` or `CLOSED` takes their number back
  with it. Consent that cannot be withdrawn is not consent, and a test asserts
  the number disappears again.
- **It is symmetric.** The thread carries both parties' details, so the seeker's
  number reaches the lister at the same moment and by the same act. A mask that
  protected only one side would be a mask on the wrong thing.
- **An admin sees it.** Moderating a listing without being able to reach its
  owner is not moderation.

`viewerHasEnquired` travels with the listing so the panel can say "you have a
conversation open" and link to it, rather than offering a form that would create
a second place to write into the same thread.

### D70. The admin plugin was mounted and inert, because `adminRoles` is not the permission check

`docs/audit-2026-09.md` records the Better Auth admin plugin as **implemented,
"Not a gap"**, on the evidence that `adminPlugin({ defaultRole: DEFAULT_ROLE,
adminRoles: ['ADMIN'] })` is in the config. It is. It also did nothing.

Measured against the running API, signed in as the seeded `admin@dev.local`:

| Endpoint            | Before                                         |
| ------------------- | ---------------------------------------------- |
| `/admin/list-users` | 403 `YOU_ARE_NOT_ALLOWED_TO_LIST_USERS`        |
| `/admin/ban-user`   | 403 `YOU_ARE_NOT_ALLOWED_TO_BAN_USERS`         |
| `/admin/set-role`   | 403 `YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE` |

Every endpoint on the plugin. The cause is that `adminRoles` and the permission
check are two different mechanisms. `adminRoles: ['ADMIN']` gets a caller past
the "is this an admin at all" gate; each endpoint then asks
`roles[session.role]` for a specific statement, and the plugin's built-in map
holds exactly two keys — `admin` and `user`. `ADMIN` is neither, the lookup
misses, and the answer is no.

**It fails closed and silently.** Nothing throws, nothing logs at error, no
build step complains. A page listing users renders perfectly and every button
returns 403. This is D23's failure mode — a rule that reads as covered and is
not — and it is worth noting that the audit's own method (grep the config,
confirm the option is present) is what missed it. The option was present. The
behaviour was absent.

**Chosen: define the access control in our role names**, with
`createAccessControl(defaultStatements)` and a role per `UserRole`. After it,
the same three endpoints answer 200 and the writes land — `set-role` to
`LISTER` and back, `ban-user` writing `banned` and `banReason`, `unban-user`
clearing them.

Three details are decisions rather than mechanics:

- **Impersonation is granted to nobody.** The plugin ships
  `/admin/impersonate-user`, which would let an operator read somebody's
  private enquiry threads as them. Nothing in this product needs it, and an
  unused permission is one nobody is watching — so the statement is omitted
  from every role rather than granted and left un-exercised. Verified: it still
  answers 403 after the fix, which is the point.
- **The definition lives in `@machiya/shared/auth-access`, not in the API.**
  Both ends need it and for different reasons: without it the server 403s
  everything, and without it `authClient.admin.setRole` is typed to
  `'admin' | 'user'` and refuses a role this product actually has. Two copies
  would be the worst case — the runtime allowing what the types forbade, which
  is how a cast ends up at the call site and the only check there was
  disappears. A **subpath**, for the same reason as `/images` and `/cities`
  (D34, D49): the module reaches into `better-auth`, and neither the worker nor
  `packages/db` has any business pulling that in.
- **`ac` is annotated, and the annotation is load-bearing.** Left inferred, the
  emitted `.d.ts` describes it as an anonymous object shape, and
  `adminPlugin`'s `AC extends AccessControl` cannot be inferred from that — so
  the same value that compiles inside `packages/shared` fails to compile in
  `apps/api`. It only appeared when the definition crossed a package boundary,
  which is the moment it was moved. `AccessControl<typeof defaultStatements>`
  fixes it.

The browser client gets `roles` and **not** `ac`: `adminClient` types that
option as the un-parameterised `AccessControl`, so an `ac` built from concrete
statements is not assignable to it, and the client only needs the role names
anyway. The server gets both.

`pnpm auth:check` and `pnpm auth:routes` do not catch this — the schema is
correct and the routes exist; it is the permission map that was wrong. So the
three curl probes above are recorded here and named in
`apps/api/src/auth/access.ts`, and they are what to re-run after a Better Auth
upgrade.

### D71. The admin page answers "what is broken" and "where next", not just "who signed up"

Two operational views already existed with nowhere to live: the per-adapter
fuel scrape health from step 8, at a `/admin/fuel` URL nothing linked to, and
the `CoverageRequest` table from D55, which had a write path and no reader at
all. Both are now tabs on one admin shell, and they are ordered ahead of user
management deliberately — moderation first because it is the only queue that
grows on its own, coverage demand second because it is the question this
product is trying to answer for itself.

Three decisions inside it:

- **The moderation queue is oldest-first and holds only unverified rows.**
  Newest-first leaves the oldest unreviewed listing unreviewed forever, which
  is the failure a queue exists to prevent. Verifying takes the row off the
  list, so the count means "outstanding" rather than "total" — and `unverify`
  therefore cannot live in the queue, because it would be a button that removes
  the row it sits on and can never be pressed again.
- **The owner's account age is on the row.** A listing published by an account
  two hours old is the shape of a spam run, and a moderator should not have to
  open a second page to see it.
- **Coverage demand is clustered spatially and ranked by distinct people.**
  `ST_ClusterDBSCAN` over the geography column at the same 50 km radius the
  public endpoint reports back, `minpoints => 1` so a city nobody has asked
  about twice is still a data point rather than DBSCAN noise. Ranking by asks
  would let one determined person choose the fourth city; ranking by rows would
  be worse still, since D55 already dedupes per person per point. Verified
  against the seeded database with three planted requests: Mumbai and Thane,
  19 km apart, collapse into one cluster of 2 people and 4 asks with the label
  "Mumbai", while Hyderabad 600 km away stays its own cluster of 1.

The page states the people-versus-asks distinction in words rather than leaving
it to a column header, because "40 requests" and "40 people" are the same number
for very different reasons and only one of them is a reason to build a city.

## Correction 12 — closing what step 10 left open

### D72. A rotated photo reported the dimensions of the bytes we did not write

D66 left the orientation case untested and said so plainly: proving that
`.rotate()` applies an EXIF orientation "needs a fixture carrying a real
orientation tag, which means committing binary image data — left undone
deliberately". That framing had one option too few. The APP1 segment can be
**assembled in the test** — a 26-byte TIFF header with a single Orientation
entry, spliced in after the SOI marker — which is generated, readable and
diffable rather than an opaque blob in the repository.

Writing it found the bug the gap had been hiding.

`validateAndDerive` read `width` and `height` from `sharp(bytes).metadata()`
and returned them unchanged, while every variant it wrote came from
`sharp(bytes).rotate()`. For a photo tagged orientation 5-8 those are
**transposed**: the stored numbers describe the input, and the servable bytes
are the other way round.

Measured on sharp 0.35.4, with a 400x200 JPEG tagged orientation 6:

| Call                                            | Result        |
| ----------------------------------------------- | ------------- |
| `sharp(bytes).metadata()`                       | 400 x 200     |
| `sharp(bytes, { autoOrient: true }).metadata()` | 400 x 200     |
| `sharp(bytes).rotate().toBuffer(...)` → `info`  | **200 x 400** |

Note the middle row: `autoOrient` does not transpose what `metadata()` reports
in this version, so the obvious fix does not work and would have looked like it
did.

**Chosen: transpose the reported pair when `metadata.orientation >= 5`**, which
is the EXIF definition of the four values that swap the axes, with the test
asserting sharp agrees rather than taking the rule on faith. The alternative —
materialising the rotated pipeline to read its real `info` — re-encodes a
twelve-megabyte photo to learn two integers.

Who this was hurting: **every portrait photo taken on a phone**, which is most
of them. `ListingImage.width`/`height` are what the gallery reserves space with,
so a portrait photo reserved a landscape box and the layout jumped when the real
image arrived — and the API's `listingImageSchema` was describing a variant it
was not describing.

The test now asserts its own premise before what follows from it (the fixture
really does read back orientation 6), the same discipline D66 introduced for the
EXIF strip. Without that, a fixture that quietly carried orientation 1 would
make the whole thing pass for the wrong reason — which is exactly how the two
tests in D66 came to be worthless.

### D73. Transit fares are the one commute input nothing can refresh, so CI watches the date

Every other input to the commute engine has a freshness mechanism. Fuel prices
are scraped hourly with per-adapter health (D62). Road distances come from OSM
artifacts whose epoch makes stale answers unreachable (D46). Bus fares have
neither: no free API publishes Indian city bus slabs, so they are configuration
in the city record — and configuration rots in total silence. A transit commute
costed from a three-year-old slab is wrong with no symptom anywhere, which is
precisely the class of failure this project keeps recording.

**Chosen: `CityConfig.transitFareReviewedOn`, and a `cities:validate` warning
past `TRANSIT_FARE_STALE_AFTER_DAYS` (365).** It runs in CI, so the staleness
surfaces there rather than in somebody's rent decision. A **warning**, not an
error: stale fares are a prompt to go and check, not a reason to fail a build
that has nothing to do with them. A malformed date IS an error, because treating
it as merely stale would leave it warned about forever.

**The field is on the city record, not on `transitFareConfigSchema`**, and the
first attempt got that wrong. Putting it in the fare schema broke four commute
tests immediately, and the breakage was the right answer to the wrong question:
that schema is the **pricing contract** — the engine needs `baseFare`, `perKm`
and `minFare`, and has no business knowing when somebody last checked them.
Folding provenance into it forced every caller that prices a journey to carry a
date it never reads. Provenance belongs to the record that holds the data, not
to the data.

Verified by backdating all three cities to 2023-01-01: three warnings, one per
city, naming the age in days and the field to bump. With the real dates,
`pnpm cities:validate` reports "OK — no issues".

### D74. A live test that reads from cache is not a live test

`known-issues.md` recorded that tier 2 of the autocomplete was stubbed in every
suite — the gap that let D57, D58 and D60 all reach a live run undetected. So a
suite was added against the real Nominatim, re-running those entries' own
measurements.

It passed. It also passed when pointed at the **public** instance, which answers
403 to this project's contact string — the exact misconfiguration D57 is about.

The provider caches every lookup in Redis for seven days. The whole file was
being served from a previous local run: a live test that never went live, and
one that would have reported everything healthy while the configured geocoder
refused every request. Precisely the failure it was written to prevent.

Two things came out of it:

- **The suite flushes the geocode keys first**, and the flush goes through a new
  `cacheDeleteMatching` in `lib/cache.ts` rather than raw ioredis. Two reasons:
  the cache client is deliberately fail-fast with no offline queue, so a `scan`
  issued straight at it rejects on a fresh process (D21, D46) — which is how the
  first attempt failed — and D60 already records that deleting these keys with
  `xargs` silently does nothing, because a geocode key contains the query text
  and therefore spaces.
- **The suite is now verifiable as a test.** Against the local instance: 6
  passing. Against `https://nominatim.openstreetmap.org` with the same contact
  string: 5 failing, led by `NOMINATIM_URL (…) refused the request`. A live
  test that cannot be made to fail by breaking the thing it watches is not
  evidence of anything, and checking that is now part of writing one here.

One limit, stated rather than implied: the first assertion catches a **refusing**
upstream, whatever the cause. It does not distinguish the local instance from a
public one that happens to answer, so it is not a substitute for reading
`NOMINATIM_URL`.

### D75. `minio/mc` is pinned, because what it does is set an access policy

D11 made `minio/mc:latest` the one unpinned image in the compose file, on the
grounds that it "only creates a bucket and exits" and that `mc` release tags
move faster than they are worth tracking. That description is incomplete, and
the incompleteness is the whole argument.

What `minio-init` actually does is run `mc anonymous set none` on the bucket and
`mc anonymous set download` on `variants/` — it sets **who can read uploaded
photographs**. D35 exists because an earlier version granted the whole bucket,
which published every unvalidated upload. A silently newer `mc` changing how
`anonymous set` parses its arguments, or what it does with a prefix, would move
that boundary with nothing in the diff.

Pinned to `RELEASE.2025-08-13T08-35-41Z` — the version `latest` currently
resolves to, confirmed with `mc --version` against the local image and with
`docker manifest inspect` for the tag. The same pin is used in the CI step that
prepares the bucket for the end-to-end suite, so the two cannot drift.

"It only creates a bucket" was the reasoning. "It decides what is public" is the
job.

## Correction 13 — the UX repair

### D76. The commute answer is a function of the request, not of ambient session state

The commute controls did nothing. Not "did nothing when signed out", not
"sometimes lagged" — moving vehicle, mileage, fuel, trips or working days left
every figure on screen exactly where it was, which is the product's entire
argument rendered as decoration. `docs/ux-audit.md` 1.1 has the reproduction.

**The cause was one line, and it was not in the client.**
`GET /api/listings/:slug/commute` carried `cache-control: private, max-age=120`
while its answer varied by the caller's **stored** preferences — which appear in
no URL and in no `Vary` header. So the browser answered the refetch from its own
cache for two minutes, and TanStack's invalidation never reached the server. The
comment above the line read "Private: it depends on the caller's own settings",
which is precisely why a URL-keyed cache was the wrong instrument.

Measured, signed in, after setting mileage to 36:

| Probe                                | Answer                                     |
| ------------------------------------ | ------------------------------------------ |
| `GET /api/me/commute`                | `mileageKmPerLitre: 36` — the write landed |
| The app's own commute URL            | `perMonth: 219.33` — the previous value    |
| The same URL plus `&mode=car`        | `perMonth: 328.99` — correct               |
| The app's own URL, two minutes later | `perMonth: 274.16` — correct               |

That also explains why it "worked sometimes": a change took effect if and only
if 120 seconds had passed since that URL was last fetched.

**Chosen: the settings travel in the URL.** `commutePreferencesToQuery` puts
mode, vehicle class, fuel, mileage, trips and working days into the query
string; `getListingCommute` and the search take them as overrides that win over
the stored row. The URL now determines the answer, so `max-age=120` is honest
again — and when the parameters are **absent** the response is `private,
no-store`, because then it does depend on the session.

Three things fall out, and each fixes something else that was broken:

- **Signed out works.** Previously the only source of preferences was a query
  gated on `isSignedIn`, so there was no cache entry, the optimistic update was
  a no-op against `undefined`, and the PATCH 401'd. The hook's comment claimed
  "the controls still work, nothing is saved"; nothing worked. Preferences are
  now client-first in `stores/commute-preferences.ts`, persisted to the server
  when there is a session and to `localStorage` when there is not.
- **The list and the panel agree.** The search endpoint takes the same
  parameters, so the total-cost column on every card is computed from the
  settings the panel is showing. They were two different sources before.
- **The per-listing override the brief asks for is the same mechanism.** Sending
  parameters does not touch the stored row, so a one-off experiment is already
  distinct from a preference change.

**`reconcileCommutePreferences` is in `@machiya/shared`, and it coerces rather
than refuses.** "Mode bike with vehicle sedan" is the combination D63 warns
about, and the UI produced it — switching to Bike left a sedan selected and
priced the ride at 13 km/l. The mode wins and the vehicle moves to that mode's
default, because the mode is what the person clicked and there is no reading
where the sedan was the intent. A 400 would punish an old client for something
resolvable. It lives in shared because both ends apply it: two copies would let
the client display what the server would not charge.

One implementation note worth keeping: composing the two query schemas with
`.merge()` throws `Invalid input to extend: expected a plain object` at request
time under zod 4, not at build time. They are parsed separately instead. The
test suite caught it; the typechecker did not.

### D77. Setting the office is click-then-confirm, and dragging is the thing made visible

A single click anywhere on the map moved the office. Measured: one click
2.4 km from the pin silently re-anchored every distance, ring and commute figure
on screen, with no confirmation and no undo (docs/ux-audit.md 1.5). The code was
deliberate about it — "A click on the map itself moves the office. This is the
second of the three ways to set one."

The trouble is that the three ways were not equal. Dragging the pin was already
implemented and safe, and it was a 16px dot with no affordance; the field was
discoverable; and the click was the one a person performs by accident while
reading a map. The destructive gesture was the discoverable one.

**Chosen: a click offers, it does not act.** The click drops a confirmation
anchored at the point — "Set office here" and a dismiss — and the office moves
only when that is pressed. Escape dismisses it, so does moving the office by any
other route, and the bubble stops its own click from reaching the map beneath it
(otherwise the confirmation walks out from under itself).

Considered and rejected:

- **A modifier or long-press.** Undiscoverable on a desktop and indistinguishable
  from a slow tap on a phone.
- **A mode the user enters.** A mode is a thing to leave, and this is a
  once-a-session action.
- **Nothing at all on click, drag only.** Correct about the danger and wrong
  about the need: setting an office by dragging a pin across a city is worse
  than pointing at where you work.

The pin itself is now 24px with a grab cursor, a hover scale and a title, so the
safe mechanism is the visible one. That is the actual repair — the click
behaviour was a symptom of dragging being invisible.

The office field and the saved-office list remain the other two ways in, and
neither changed.

## D78 — The detail panel is modal on a phone and not on a desktop

The brief asked for outside-press dismissal and a focus trap, and for shadcn
components rather than bespoke ones. A shadcn `Sheet` is a Radix dialog, and a
Radix dialog is modal: an overlay that swallows presses, focus trapped inside,
the page behind it inert. Applied to both breakpoints that would have broken the
product.

On a desktop the map behind the panel is **live and load-bearing**. Pressing
another marker switches listings, the office pin still drags, the ring counts
still update. A modal overlay ends all of that, and trapping focus would put the
search field out of reach without first closing the listing you are comparing
against it.

On a phone the sheet covers the page. There is nothing behind it to interact
with, so everything a modal gives is right there.

**Chosen: one component, two modes.**

|               | desktop                                                  | mobile                          |
| ------------- | -------------------------------------------------------- | ------------------------------- |
| Escape        | closes                                                   | closes                          |
| Outside press | the map's own click handler closes it                    | a scrim closes it               |
| Focus trap    | no — 13 of 40 Tabs reach the search behind it, by design | yes — 30 of 30 Tabs stay inside |
| Focus return  | to the card that opened it                               | to the card that opened it      |

The desktop "outside press" lives in `SearchMap`'s click handler rather than in
an overlay, because only the map knows whether the press landed on a marker, a
cluster or bare ground. With a listing open, bare ground means dismiss; with
none open, it means the office confirmation from D77. The two never fire at
once.

Focus return is explicit rather than left to the browser. Closing is a history
navigation and the list behind the panel stays mounted, so the card element is
still there — the panel captures `document.activeElement` on mount and restores
it on unmount if it is still connected.

**Why not shadcn anyway, with `modal={false}`.** A non-modal Radix dialog gives
up the trap for both breakpoints, so the phone would lose the half that is
correct there, and the drag-to-dismiss sheet with velocity-aware snap points has
no equivalent in `Sheet`. The panel stays bespoke; the parts of it that are
plain chrome — buttons, separators, cards — are shadcn already.

## D79 — Closing the panel tests the router's key, not `window.history.length`

`history.length` counts the entire tab, including entries this app never made.
A listing opened from a link on another site had `length > 1`, so Close called
`navigate(-1)` and sent the user **back to that site** (docs/ux-audit.md 1.7).
The intent in D45 was right and the test for it was wrong.

**Chosen: `useLocation().key !== 'default'`.** React Router stamps `default` on
the entry the tab loaded with and generates a key for every entry it pushes
itself, which is exactly the question being asked: did we push this? Back when
we did; a fresh navigation to the search when we did not.

It lives in `hooks/use-close-detail.ts` because two places close the panel now —
the panel's own controls and a press on the map behind it — and two copies of
this test would drift.
