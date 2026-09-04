# Setup

**Read this when** you are getting the stack running for the first time, or a
compose profile is not behaving.

## Prerequisites

- **Node 22** and **pnpm 10**. Prisma 7 needs Node ≥ 20.19; the repo pins 22.
- **Docker**, with compose v2.
- Roughly **3 GB of disk** if you build the geo services: ~1 GB of Geofabrik
  downloads cached in `.osm-cache/`, plus the OSRM graphs and the Nominatim
  database.
- The **OSRM images are `linux/amd64` only** — verified with
  `docker manifest inspect --verbose osrm/osrm-backend:v5.25.0`, which returns a
  single manifest rather than a manifest list. They are pinned with
  `platform: linux/amd64` and run under emulation on Apple silicon. Nothing
  breaks; the graph build is just slower.

## First run

```bash
pnpm install
cp .env.example .env
docker compose up -d postgis redis minio minio-init mailhog
pnpm bootstrap                       # OSM cuts, OSRM graphs, Nominatim + Overpass
docker compose --profile geo up -d nominatim overpass osrm-car osrm-bike   # NAME them — see below
pnpm seed:photos                     # fetches the seed photographs (see below)
pnpm db:deploy                       # apply migrations
pnpm cities:boundaries               # city polygons, from the local Nominatim
pnpm db:seed                         # 3 cities, 51 listings, 3 dev accounts
pnpm dev                             # api :4000, worker :4100, web :5173
```

`pnpm bootstrap` is the long one — roughly 1 GB of cached downloads plus the
graph builds and two imports. Everything else runs in seconds. Skip it and the
core stack still works: routing, geocoding and POIs degrade with a label rather
than failing (D43, D48), and `pnpm geo:status` will tell you what is missing.

Use `pnpm db:deploy` rather than `pnpm db:migrate` for setup: `deploy` applies
migrations with no drift check, which is what a fresh database wants.

To run everything in containers instead of on the host:

```bash
docker compose up -d     # adds api, worker and web
```

…then open http://localhost:8080. `api` and `worker` declare their
`healthcheck:` in `docker-compose.yml`, next to the `depends_on` that reads it —
compose does honour a Dockerfile `HEALTHCHECK`, but a condition defined in a
different file is one that silently stops being satisfiable if the image is
rebuilt or retagged without that layer.

## Seed photos

`pnpm db:seed` needs the photo set, and it will refuse with a message naming the
command if it is missing. `pnpm seed:photos`:

- with `UNSPLASH_ACCESS_KEY` set in the root `.env` and no manifest yet, queries
  the Unsplash API and writes `scripts/fixtures/photos.json`;
- with a manifest present, downloads only what is missing and **never** re-queries
  the API — so a machine with no key reproduces the identical seed;
- with neither a key nor a manifest, falls back to `picsum.photos` at fixed ids.
  Keyless, deterministic, still real photographs.

The manifest is committed; the binaries under `scripts/fixtures/photos/` are not.
`UNSPLASH_ACCESS_KEY` is read only by that script, on the host — it is
deliberately absent from every compose service's environment. Get one free at
https://unsplash.com/oauth/applications. See DECISIONS.md D31.

## Environment

`.env.example` is the reference and every value in it has a working local
default. Copy it to `.env`; nothing in it is a real secret.

The one variable with no usable default is `BETTER_AUTH_SECRET` — compose fails
fast with `set BETTER_AUTH_SECRET in .env` rather than starting an API that
signs forgeable cookies. Generate one with `openssl rand -base64 32`.

Prisma 7 does **not** load `.env` itself. `prisma.config.ts` at the repo root
loads it, resolved from that file's own directory rather than the current one, so
every `pnpm db:*` script works from anywhere in the workspace. See DECISIONS.md
D5.

## Compose profiles

| Command                                                                    | Brings up                                       |
| -------------------------------------------------------------------------- | ----------------------------------------------- |
| `docker compose up -d postgis redis minio minio-init mailhog`              | just the infrastructure — what `pnpm dev` needs |
| `docker compose --profile geo up -d nominatim overpass osrm-car osrm-bike` | the geo services, and nothing else              |
| `docker compose up -d`                                                     | ALL of the above **plus api, worker and web**   |

**Always name the services.** `docker compose --profile geo up -d` with no
service names does not "add the geo services" — it starts the named profile
**and** the default one, so it also brings up `api`, `worker` and `web` from
whatever images were last built. Those containers publish 4000, 4100 and 8080,
so a `pnpm dev` started alongside loses the race for port 4000 and dies, and the
browser talks to a stale image instead. The symptom is a 404 from routes that
exist in your working tree:

```
{"error":{"code":"not_found","message":"No route for GET /api/places/reverse"}}
```

with `/health` answering 200 the whole time, because that route is old enough to
be in the stale image too. If you see that, `docker compose stop api worker web`
and restart `pnpm dev`. To check what you are actually talking to:
`docker compose ps` and `docker compose images api`.

The containerised `api`, `worker` and `web` are a **different workflow** from
`pnpm dev`: they serve built images, not your working tree, so they need
`docker compose build` after every change. Pick one workflow per session.

The geo services sit behind a profile because they cannot start until
`scripts/bootstrap.sh` has produced the merged OSM extract and built their
indexes — in the default profile, a fresh clone's first `docker compose up` would
fail. See DECISIONS.md D6.

## Routing and geocoding

One-time, and idempotent:

```bash
pnpm bootstrap                        # ~1 GB of downloads, cached in .osm-cache/
docker compose --profile geo up -d nominatim overpass osrm-car osrm-bike
```

`scripts/bootstrap.sh` downloads the three Geofabrik India **zone** extracts that
contain the seed cities (Geofabrik publishes India by zone, not by state — see
D27), cuts each city out by bounding box with osmium, merges them into one small
`.osm.pbf`, and hands that to the OSRM graph build and the Nominatim import.
Every step skips work whose output already exists, so an interrupted run resumes
cheaply. Nothing is needed on the host but `docker`, `curl` and `pnpm` — osmium,
OSRM and Nominatim all run in containers (D28).

The Nominatim import takes tens of minutes on first boot and its healthcheck has
a 45-minute `start_period` so a cold import is not mistaken for a wedged
container. `osrm-init` refuses to start with a message naming `pnpm bootstrap` if
the merged extract is absent, rather than dying inside `osrm-extract`.

More on what each service does and how it degrades: [geo.md](geo.md).

## Ports

| Service     | URL                    | Notes                                      |
| ----------- | ---------------------- | ------------------------------------------ |
| web (vite)  | http://localhost:5173  | `pnpm dev`                                 |
| web (nginx) | http://localhost:8080  | production build inside compose            |
| api         | http://localhost:4000  | `/health`, `/health/live`, `/api/*`        |
| worker      | http://localhost:4100  | `/health`                                  |
| postgis     | localhost:5432         | user / password / db all `machiya`         |
| redis       | localhost:6379         |                                            |
| minio       | http://localhost:9000  | console :9001, `minioadmin` / `minioadmin` |
| mailhog     | http://localhost:8025  | catches every outbound mail                |
| nominatim   | http://localhost:7070  | `geo` profile                              |
| overpass    | http://localhost:12345 | `geo` profile                              |
| osrm-car    | http://localhost:5100  | `geo` profile — 5000 is AirPlay on macOS   |
| osrm-bike   | http://localhost:5001  | `geo` profile                              |

## Dev accounts

All pre-verified, password `devpass123`:

| Account            | Role   | Default office         |
| ------------------ | ------ | ---------------------- |
| `seeker@dev.local` | seeker | Boring Road, Patna     |
| `lister@dev.local` | lister | Koramangala, Bengaluru |
| `admin@dev.local`  | admin  | Kothrud, Pune          |

Passwords are hashed by Better Auth's own `hashPassword`, so if the library
changes its format the seeded accounts change with it instead of silently
failing to sign in (D32).

## Verify

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
curl -s localhost:4000/health | jq
curl -s localhost:4100/health | jq
curl -s 'localhost:4000/api/places/suggest?q=korama' | jq '.suggestions[0]'
docker compose ps        # every service should read (healthy)
```

`pnpm typecheck` covers every workspace package **and** the root-level
TypeScript — `prisma.config.ts` and `scripts/` — through `tsconfig.tools.json`.
It is a hard gate in CI alongside lint, format, test and build.
