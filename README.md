# Machiya (RentNear)

Office-centric rental discovery. Set your office on a map, see every rental or
for-sale listing within 3 km inside labelled 1/2/3 km rings, and rank them by
**total true monthly cost** — rent plus a live commute cost computed from real
road distance and scraped fuel prices.

Every dependency is free or self-hostable: no Google Maps, no Mapbox, no paid geo
APIs, no hosted auth SaaS, no paid email SDK.

## Prerequisites

Node 22, pnpm 10, Docker. The OSRM images are published for `linux/amd64` only,
so on Apple silicon they run emulated — fine, just slower to build the graphs.

## Get running

```bash
pnpm install && cp .env.example .env
docker compose up -d postgis redis minio minio-init mailhog
pnpm seed:photos && pnpm db:deploy && pnpm db:seed
pnpm dev
```

Then open http://localhost:5173. Sign in as `seeker@dev.local` /
`devpass123`. Routing and geocoding need a one-time
[`pnpm bootstrap`](docs/setup.md#routing-and-geocoding).

Name the services in every `docker compose up`. A bare `docker compose up -d`
also starts `api`, `worker` and `web` from previously built images, which take
the ports `pnpm dev` wants and then serve stale code — see
[docs/setup.md](docs/setup.md#compose-profiles).

## Documentation

| Document                                       | Read it when                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| [docs/setup.md](docs/setup.md)                 | Getting the stack running, or a compose profile is not behaving    |
| [docs/architecture.md](docs/architecture.md)   | You need the shape of the system, or the cache TTLs                |
| [docs/data-model.md](docs/data-model.md)       | You are touching the schema, a migration, or a geo query           |
| [docs/geo.md](docs/geo.md)                     | Geocoding, routing, POIs, autocomplete, or a free tier is refusing |
| [docs/images.md](docs/images.md)               | Photo upload, validation, variants, or an image is stuck           |
| [docs/auth.md](docs/auth.md)                   | Sessions, roles, guards, or a Better Auth upgrade                  |
| [docs/design.md](docs/design.md)               | You are building or changing UI                                    |
| [docs/operations.md](docs/operations.md)       | Queues, schedules, failure modes, or you need to reset something   |
| [docs/attribution.md](docs/attribution.md)     | You are publishing a screenshot of seeded data                     |
| [docs/audit-2026-09.md](docs/audit-2026-09.md) | You want to know what is actually built versus specified           |
| [DECISIONS.md](DECISIONS.md)                   | Something looks odd and you want to know whether it is deliberate  |

`DECISIONS.md` is the one to read before changing anything structural. The
entries worth knowing up front: **D2** and **D15** (`lat`/`lng` versus the
`geography` column, and why it is nullable), **D5** (Prisma 7 and where the
connection string lives), **D13** (GiST indexes belong in the schema), **D21**
(why there are two Redis connections), and **D12** (maplibre's worker, and the
silently blank map).
