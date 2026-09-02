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

| Layer | Choice |
| --- | --- |
| Monorepo | pnpm workspaces — `apps/web`, `apps/api`, `apps/worker`, `packages/shared`, `packages/db` |
| Web | Vite + React 19 + TS, react-router v7, TanStack Query, Zustand (map/filter/UI only), Tailwind v4 + shadcn/ui, react-hook-form + Zod, maplibre-gl via react-map-gl, @turf/turf |
| API | Node 22 + Express 5 + TS, Zod at every boundary, pino, helmet, express-rate-limit |
| Worker | Separate Node process, BullMQ repeatable jobs |
| DB | PostgreSQL 16 + PostGIS, Prisma 6 isolated in `packages/db` |
| Cache/queue | Redis 7 + ioredis |
| Storage | MinIO in dev via `@aws-sdk/client-s3`, Cloudflare R2 in prod by env swap |
| Auth | better-auth, self-hosted, Prisma adapter, DB-backed sessions |
| Email | Nodemailer over SMTP, MailHog in dev |

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

```bash
pnpm install
cp .env.example .env
./scripts/bootstrap.sh   # downloads + cuts + merges OSM extracts, builds OSRM graph and Photon index
docker compose up
pnpm db:reset            # drop, migrate, reseed
```

Dev credentials after seeding: `seeker@dev.local`, `lister@dev.local`, `admin@dev.local`,
all with password `devpass123`.

## Status

Greenfield. Scaffolding in progress — see `DECISIONS.md` for logged trade-offs.
