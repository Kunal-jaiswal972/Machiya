# Machiya (RentNear)

Office-centric rental discovery and listing platform. Set your office on a map, see every
rental or for-sale listing within 3 km inside labeled 1/2/3 km rings, and rank them by
**total true monthly cost** — rent plus a live commute cost computed from real road distance
and scraped fuel prices.

Every dependency is free or self-hostable: no Google Maps, no Mapbox, no paid geo APIs,
no hosted auth SaaS, no paid email SDK.

## Core features

1. **Map search from the office** — Photon autocomplete or map click sets the office;
   `ST_DWithin` radius search returns listings inside 3 km, drawn in turf-generated rings,
   clustered natively by MapLibre, filterable and shareable via URL state.
2. **Listing detail** — real OSRM road route (car + bike), image gallery, amenities,
   masked owner contact until enquiry, similar listings by KNN, and nearby POIs
   (hospitals, police, schools, pharmacies, ATMs, supermarkets, transit) from one
   batched Overpass query.
3. **Live commute cost** — hourly BullMQ scrape of petrol/diesel/CNG prices per city,
   combined with actual road distance, mileage, trips/day and working days to produce
   cost per trip, cost per month, commute-as-%-of-rent, and total monthly outlay.
   Results can be sorted by that total.
4. **Lister dashboard** — Airbnb-style multi-step listing wizard with draft autosave,
   direct-to-S3 presigned photo upload with a sharp pipeline, my-listings analytics,
   threaded enquiries, favorites, saved searches, and an admin moderation queue.

## Stack

| Layer       | Choice                                                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo    | pnpm workspaces — `apps/web`, `apps/api`, `apps/worker`, `packages/shared`, `packages/db`                                                                                     |
| Web         | Vite + React 19 + TS, react-router v7, TanStack Query, Zustand (map/filter/UI only), Tailwind v4 + shadcn/ui, react-hook-form + Zod, maplibre-gl via react-map-gl, @turf/turf |
| API         | Node 22 + Express 5 + TS, Zod at every boundary, pino, helmet, express-rate-limit                                                                                             |
| Worker      | Separate Node process, BullMQ repeatable jobs                                                                                                                                 |
| DB          | PostgreSQL 16 + PostGIS, Prisma 6 isolated in `packages/db`                                                                                                                   |
| Cache/queue | Redis 7 + ioredis                                                                                                                                                             |
| Storage     | MinIO in dev via `@aws-sdk/client-s3`, Cloudflare R2 in prod by env swap                                                                                                      |
| Auth        | better-auth, self-hosted, Prisma adapter, DB-backed sessions                                                                                                                  |
| Email       | Nodemailer over SMTP, MailHog in dev                                                                                                                                          |

## Geo stack (all free)

- **Tiles** — OpenFreeMap liberty style, no API key. Behind `VITE_MAP_STYLE_URL`.
- **Geocoding** — self-hosted Photon, Nominatim fallback at 1 req/s with Redis caching.
- **Routing** — self-hosted OSRM (car + bike profiles) from a merged three-city extract.
- **POIs** — Overpass API, one batched query per listing, Redis-cached 24h.

Each provider sits behind an adapter in `packages/shared/src/geo` so any one can be
replaced without touching feature code.

## Seed cities

Patna (Bihar), Bengaluru (Karnataka), Pune (Maharashtra) — defined in `scripts/cities.ts`.
Adding a fourth city is a single-entry change to that file.

## Getting started

Requires Node 22, pnpm 10, and Docker.

```bash
pnpm install
cp .env.example .env
docker compose up -d postgis redis minio minio-init mailhog
pnpm db:deploy           # apply migrations
pnpm db:seed             # three cities, 51 listings, dev accounts
pnpm build:packages      # builds @machiya/shared and generates the Prisma client
docker compose up -d     # adds api, worker and web
```

Then open http://localhost:8080 — the map should render Patna from OpenFreeMap and
the status card should show `api`, `postgis` and `redis` all green.

Use `pnpm db:deploy` rather than `db:migrate` for first-time setup: `deploy`
applies migrations without a drift check, which is what a fresh database wants.

For day-to-day work, run the apps on the host against the containerised
infrastructure instead:

```bash
docker compose up -d postgis redis minio minio-init mailhog
pnpm dev                 # api :4000, worker :4100, web :5173
```

Dev accounts after seeding — all pre-verified, password `devpass123`:

| Account            | Role   | Default office         |
| ------------------ | ------ | ---------------------- |
| `seeker@dev.local` | seeker | Boring Road, Patna     |
| `lister@dev.local` | lister | Koramangala, Bengaluru |
| `admin@dev.local`  | admin  | Kothrud, Pune          |

### Routing and geocoding

The geo services need a prebuilt OSM index, so they sit behind a compose profile
and a one-time bootstrap:

```bash
pnpm bootstrap                          # ~1 GB of downloads, cached in .osm-cache/
docker compose --profile geo up -d      # osrm-car, osrm-bike, nominatim
```

`scripts/bootstrap.sh` downloads the three Geofabrik India zone extracts that
contain the seed cities, cuts each city out by bounding box with osmium, merges
them into one small `.osm.pbf`, builds the OSRM car and bicycle graphs, and
imports the result into a self-hosted Nominatim. Every step is idempotent —
anything whose output already exists is skipped, so an interrupted run resumes
cheaply. Nothing needs osmium, osrm or postgres on the host; every tool runs in a
container.

Geocoding is self-hosted **Nominatim**, not Photon: Photon cannot read an
`.osm.pbf` (it imports from a Nominatim database), and no official Photon image
exists. Photon is still available as a type-ahead layer on top of the same
database behind `--profile photon`. Reasoning in [DECISIONS.md](DECISIONS.md) D26.

### Ports

| Service     | URL                   | Notes                                         |
| ----------- | --------------------- | --------------------------------------------- |
| web (nginx) | http://localhost:8080 | production build inside compose               |
| web (vite)  | http://localhost:5173 | `pnpm dev:web` on the host                    |
| api         | http://localhost:4000 | `/health`, `/health/live`, `/api/hello`       |
| worker      | http://localhost:4100 | `/health`                                     |
| postgis     | localhost:5432        | user/password/db all `machiya`                |
| redis       | localhost:6379        |                                               |
| minio       | http://localhost:9000 | console on :9001, `minioadmin` / `minioadmin` |
| mailhog     | http://localhost:8025 | catches every outbound mail                   |

The geo services (Photon, OSRM car and bike) sit behind a compose profile because
they need a prebuilt OSM index: `docker compose --profile geo up -d`, once
`scripts/bootstrap.sh` exists and has run.

### Verify

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
curl -s localhost:4000/health | jq
curl -s localhost:4000/api/hello | jq
curl -s localhost:4100/health | jq
docker compose ps      # every service should read (healthy)
```

## Auth

Better Auth, self-hosted, mounted at `/api/auth/*` with database-backed sessions
and Redis in front of them.

- email + password with **mandatory** verification, plus password reset. Both
  emails land in MailHog at http://localhost:8025 in development.
- Google and GitHub are wired but only render when the deployment both lists them
  in `AUTH_ENABLED_PROVIDERS` and supplies credentials — a button that dies at
  the OAuth redirect is worse than no button.
- roles are `SEEKER` (default), `LISTER`, `ADMIN`, on the user record and
  re-checked server-side on every request.
- credential endpoints are rate limited far harder than the rest of the API
  (5 sign-ins/min, 3 sign-ups per 5 min), counted in Redis so the limits hold
  across replicas.

Screens live at `/auth/sign-in`, `/auth/sign-up`, `/auth/forgot-password`,
`/auth/reset-password` and `/auth/verify-email`.

### Authorization

`requireAuth` and `requireRole(...)`/`requireMinRole(...)` guard the API;
`assertOwnership` re-checks the owner of every mutable resource against the
session. Nothing trusts a role, user id or owner id from a request body. The
web-side `RequireAuth`/`RequireRole` components decide what to _render_ and are
not a security boundary.

```bash
pnpm auth:check      # does schema.prisma satisfy what Better Auth writes?
pnpm auth:generate   # regenerate auth models (a draft — see DECISIONS.md D22)
BETTER_AUTH_URL=http://localhost:4000 pnpm auth:routes   # live route list
```

Run `pnpm auth:check` after every Better Auth upgrade. The published CLI lags the
library, so its generated schema can be missing columns the runtime writes — that
is a runtime 500, and this check turns it into a build failure.

## Status

Steps 1-4 of 9 done.

**1. Scaffold** — monorepo, docker compose, CI, env files, health endpoints, and a
verified end-to-end `docker compose up` rendering an OpenFreeMap tile.

**2. Database** — the full Prisma schema, PostGIS and pg_trgm, GiST and trigram
indexes, the `lat`/`lng`-to-`geography` sync trigger with a CHECK constraint
behind it, and `packages/db/src/geo-queries.ts` — the only module in the repo
containing raw SQL. 39 tests against a real PostGIS container.

**3. Auth** — Better Auth with the Prisma adapter, DB-backed sessions, email
verification and password reset through MailHog, env-driven social providers, the
admin plugin, Redis-backed rate limiting, server-side guards with 20 tests, and
the five web auth screens.

**4. Data** — `scripts/cities.ts` as the single city config, `scripts/bootstrap.sh`
for the OSM/OSRM/Nominatim pipeline, and an idempotent, deterministic seed: 3
cities, 16 amenities, 51 listings across every enum value, 3 dev accounts with
working passwords and saved offices, enquiry threads, favourites, saved searches,
fuel prices, and 8 placeholder photos uploaded to MinIO.

Next: listing CRUD — presigned MinIO uploads, the sharp image pipeline, and
ownership checks on every mutation.

### Database notes

```bash
pnpm db:deploy      # apply migrations (no drift check — use this for setup)
pnpm db:migrate     # create a new migration from a schema change
pnpm db:seed        # re-seed; idempotent, prunes listings no longer planned
pnpm db:studio      # browse the data
pnpm -F @machiya/db test    # geo query suite against real PostGIS
```

`prisma migrate reset` refuses to run non-interactively in Prisma 6.19 without an
explicit consent variable, so `pnpm db:reset` will prompt. To rebuild a local
database from scratch without it, drop and recreate the schema:

```bash
docker compose exec postgis psql -U machiya -d machiya   -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
docker compose exec -T postgis psql -U machiya -d machiya   < scripts/postgres-init/zz-prisma-owns-extensions.sql
pnpm db:deploy
```

Every non-obvious choice is logged in [DECISIONS.md](DECISIONS.md). The ones worth
reading before touching this code: D2 and D15 (`lat`/`lng` versus the `geography`
column, and why it is nullable), D13 (GiST indexes belong in the schema), D21
(why there are two Redis connections), D22 (why the auth schema is checked
against the runtime), and D12 (maplibre's worker, and the silent blank map).
