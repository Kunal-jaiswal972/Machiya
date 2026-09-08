# Machiya (RentNear)

Office-centric rental discovery. Set your office on a map, see every rental or
for-sale listing within 3 km inside labelled 1/2/3 km rings, and rank them by
**total true monthly cost** — rent plus a live commute computed from real road
distance and scraped fuel prices. Owners list their properties through a
resumable wizard and answer enquiries in the same app.

Rent is not what you pay. A ₹14,000 flat 12 km out costs a car commuter ₹17,991
a month against ₹17,000 for one they can walk to, and no listing site shows them
that. [docs/why.md](docs/why.md) is the argument in full.

Every dependency is free or self-hostable: no Google Maps, no Mapbox, no paid
geo APIs, no hosted auth SaaS, no paid email SDK.

## Prerequisites

Node 22, pnpm 10, Docker. The OSRM images are published for `linux/amd64` only,
so on Apple silicon they run emulated — fine, just slower to build the graphs.

## Get running

```bash
pnpm install
pnpm bootstrap            # creates .env, generates its secrets, builds the OSM artifacts
docker compose up -d postgis redis minio minio-init mailhog
pnpm seed:photos && pnpm db:deploy && pnpm db:seed
pnpm dev
```

Then open http://localhost:5173. `pnpm bootstrap` is once per machine and takes
around 40 minutes, almost all of it OSRM graph builds and two imports; skip it
and the app still runs, it just says routing, geocoding and POIs are unavailable
rather than failing.

Name the services in every `docker compose up` **when you are using `pnpm
dev`**. A bare `docker compose up -d` also starts `api`, `worker` and `web` from
previously built images, which take the ports `pnpm dev` wants and then serve
stale code — see [docs/setup.md](docs/setup.md#compose-profiles).

## Or run the whole stack in Docker

No `pnpm dev`, no host processes — thirteen containers, the app on
http://localhost:8080:

```bash
docker compose --profile geo up -d      # start all 13
docker compose --profile geo down       # stop and remove all 13
```

The flag belongs on **both**. A bare `down` removes only the eight
default-profile containers and then tears out the network the geo five are still
using, which kills them with `network … not found`; if that has already
happened, `docker compose --profile geo rm -sf` before starting again. Volumes
survive `down`, so nothing re-imports.

## Dev accounts

All six use the password `devpass123`. Two of each role, because a single
account per role can only prove that the owner is allowed in — the second one is
what shows a lister cannot touch the other lister's listing.

| Account             | Role   | Use it for                                         |
| ------------------- | ------ | -------------------------------------------------- |
| `seeker@dev.local`  | SEEKER | The search, favourites, saved searches, enquiries  |
| `seeker2@dev.local` | SEEKER | The other side of a seeker-scoped permission check |
| `lister@dev.local`  | LISTER | The dashboard, the wizard, the enquiry inbox       |
| `lister2@dev.local` | LISTER | Owns half the seeded stock; the cross-owner checks |
| `admin@dev.local`   | ADMIN  | Moderation, coverage demand, scrape health, users  |
| `admin2@dev.local`  | ADMIN  | Admin actions attributed to a second moderator     |

The seed populates **Patna only** — 100 listings, an even rent/sale split, split
across the two listers. Bengaluru and Pune are still covered (the OSM artifacts
and the coverage set include them) but have no stock; see
[D91](DECISIONS.md#d91--the-seed-covers-one-city-with-real-depth).

Outbound mail goes to MailHog at http://localhost:8025.

## Commands

```bash
pnpm dev          # api, worker and web together
pnpm typecheck    # every package, tests included — a hard gate
pnpm lint
pnpm test         # unit and live-service suites
pnpm -F @machiya/e2e test   # one path through the whole stack; needs compose up
pnpm bootstrap    # one-time OSM download, extract and index build
pnpm geo:status   # what each geo artifact is, and the command that rebuilds it
```

## Documentation

| Document                                       | Read it when                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| [docs/why.md](docs/why.md)                     | You are new, or a decision looks arbitrary and you want the reason |
| [docs/setup.md](docs/setup.md)                 | Getting the stack running, or a compose profile is not behaving    |
| [docs/architecture.md](docs/architecture.md)   | You need the shape of the system, or the cache TTLs                |
| [docs/data-model.md](docs/data-model.md)       | You are touching the schema, a migration, or a geo query           |
| [docs/geo.md](docs/geo.md)                     | Geocoding, routing, POIs, autocomplete, or a free tier is refusing |
| [docs/adding-a-city.md](docs/adding-a-city.md) | You are adding a city, or want to know what that actually costs    |
| [docs/images.md](docs/images.md)               | Photo upload, validation, variants, or an image is stuck           |
| [docs/auth.md](docs/auth.md)                   | Sessions, roles, guards, or a Better Auth upgrade                  |
| [docs/design.md](docs/design.md)               | You are building or changing UI                                    |
| [docs/operations.md](docs/operations.md)       | Queues, schedules, failure modes, or you need to reset something   |
| [docs/known-issues.md](docs/known-issues.md)   | Something looks broken and you want to know if it already is       |
| [docs/attribution.md](docs/attribution.md)     | You are publishing a screenshot of seeded data                     |
| [docs/audit-2026-09.md](docs/audit-2026-09.md) | You want to know what is actually built versus specified           |
| [DECISIONS.md](DECISIONS.md)                   | Something looks odd and you want to know whether it is deliberate  |

`DECISIONS.md` is the one to read before changing anything structural. The
entries worth knowing up front: **D2** and **D15** (`lat`/`lng` versus the
`geography` column, and why it is nullable), **D5** (Prisma 7 and where the
connection string lives), **D13** (GiST indexes belong in the schema), **D21**
(why there are two Redis connections), **D12** (maplibre's worker, and the
silently blank map), and **D67** (why a draft listing has nullable columns).
