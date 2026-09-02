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
pnpm build:packages      # builds @machiya/shared and generates the Prisma client
docker compose up -d     # postgis, redis, minio, mailhog, api, worker, web
```

Then open http://localhost:8080 — the map should render Patna from OpenFreeMap and
the status card should show `api`, `postgis` and `redis` all green.

For day-to-day work, run the apps on the host against the containerised
infrastructure instead:

```bash
docker compose up -d postgis redis minio minio-init mailhog
pnpm dev                 # api :4000, worker :4100, web :5173
```

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

## Status

Step 1 of 9 done: monorepo, docker compose, CI, env files, health endpoints, and a
verified end-to-end `docker compose up` rendering an OpenFreeMap tile.

Next: `packages/db` — Prisma schema, the PostGIS extension and GiST index
migrations, the lat/lng sync trigger, and `geo-queries.ts` tested against a real
PostGIS container.

Every non-obvious choice is logged in [DECISIONS.md](DECISIONS.md). Two worth
reading before touching the map or the database: D2 (how `lat`/`lng` stays in sync
with the `geography` column) and D12 (why maplibre's worker is copied into
`public/`, and the silent blank-map failure if it is not).
