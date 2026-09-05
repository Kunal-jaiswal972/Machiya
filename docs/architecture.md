# Architecture

**Read this when** you need the shape of the system, the path a request takes,
or the cache TTL for something.

## The pieces

```
                       browser (apps/web)
                    Vite + React 19 + maplibre-gl
                              │
                    ┌─────────┴──────────┐
                    │                    │
              HTTP  │              tiles │ (OpenFreeMap, no key)
                    ▼                    ▼
            apps/api (Express 5)   tiles.openfreemap.org
             Zod at every edge
                    │
      ┌─────────────┼───────────────┬──────────────┐
      ▼             ▼               ▼              ▼
  PostGIS 16     Redis 7         MinIO / R2    nominatim
  (Prisma 7)   cache + queue   presigned POST   osrm x2
      ▲             │                ▲          overpass
      │             │ BullMQ         │
      │             ▼                │
      └──────  apps/worker  ─────────┘
              sharp, scrapers, mail,
              reconcilers, cleanup
```

`packages/shared` holds everything both sides need: Zod schemas, the geo
provider interfaces, the image derivation code, and the Better Auth
access-control map that the server and the browser client must agree on.
`packages/db` holds the Prisma schema, the client, and every line of raw SQL in
the repo.

Three of those are **subpaths** rather than package-index exports —
`@machiya/shared/images`, `/cities` and `/auth-access` — because each reaches
for something the browser bundle must never pull in: sharp, `node:crypto`, and
better-auth respectively.

`apps/e2e` is tests only. It carries one path through every subsystem against
the real stack and lives in its own package because sharp must not enter
`apps/api` (D34), and because a suite that needs Redis, MinIO and OSRM up does
not belong among the fast hermetic ones.

## Why the worker is a separate process

Four reasons, and the first cut of the image pipeline got this wrong by putting
sharp in the API (D34):

1. Uploads already go **browser → storage** through a presigned POST, so
   deriving in the API would mean downloading the object back to resize it.
2. libvips spikes CPU and RSS. A twelve-photo listing upload must not be able to
   degrade request serving; that work belongs somewhere it can be scaled,
   memory-capped and restarted independently.
3. It keeps sharp's platform-specific native binaries out of the API image.
4. BullMQ, retries and backoff were needed for the fuel scrapers anyway. Image
   derivation is the same shape of work — and so, later, was outbound enquiry
   mail: a slow SMTP server must not hold a request open either (D68).

The API therefore reads no image bytes at all. It signs uploads, confirms with
`headObject` that the object landed, and enqueues.

## The request path

A search — the one path that matters most:

1. `GET /api/listings/search?…` with the office coordinate, radius, filters,
   sort and cursor. Every parameter is Zod-parsed at the route.
2. `packages/db/src/geo-queries.ts` composes **one** parameterised statement:
   `ST_DWithin` against the GiST-indexed `geography` column bounds it,
   `ST_Distance` and the ring are computed in the same pass, and every filter is
   a bound parameter in the same `WHERE`. Nothing fetches a superset and filters
   it in JavaScript.
3. Rows are Zod-parsed on the way out, so a schema change that breaks a query
   fails loudly at the boundary rather than as `undefined` three layers up.
4. Pagination is row-constructor keyset on `(sortKey, id)`, not `OFFSET` (D19).

Road distance, POIs and fuel prices are **not** in that query. They are separate
cached lookups, because each has a different failure mode and a different TTL,
and none of them may block the list from rendering.

## Cache TTLs

All in Redis, all defined once in `packages/shared/src/constants.ts`
(`CACHE_TTL_SECONDS`) so the API and the worker cannot disagree.

| Data                   | Key                                     | TTL    | On a miss                                      |
| ---------------------- | --------------------------------------- | ------ | ---------------------------------------------- |
| Geocode / autocomplete | `geocode:nominatim:{query}`             | 7 days | Ask Nominatim; tier 1 answers regardless       |
| Reverse geocode        | `geocode:nominatim:reverse:{lat},{lng}` | 7 days | Ask Nominatim; null is a valid answer          |
| OSRM route             | `route:{profile}:{from}:{to}`           | 24 h   | Ask OSRM; degrade to straight line with a flag |
| Overpass POIs          | `poi:{lat},{lng}:{radius}`              | 24 h   | Ask Overpass; serve stale-or-empty with a flag |
| Fuel prices            | `fuel:{citySlug}`                       | 1 h    | Read Postgres `FuelPrice` with a `staleAt`     |

Two rules hold across all of them:

- **Nothing blocks on the cache.** The cache Redis connection is deliberately
  fail-fast with no offline queue, so a command issued while Redis is down
  rejects immediately rather than hanging a request (D21). Every caller has a
  Postgres fallback or a degraded answer.
- **"Could not refresh" and "there is nothing" are different answers.** Providers
  return a `degraded` flag rather than an empty result, because to someone
  choosing where to live, "no hospitals nearby" and "we could not check" mean
  opposite things.

## Two Redis connections

`apps/api/src/lib/redis.ts` exports two clients with opposite failure policies,
and this was not theoretical — the rate limiter's first `INCR` on the cache
client's settings turned every sign-up into a 500 (D21).

- `redis` — cache. `lazyConnect`, no offline queue, fails fast.
- `authRedis` — sessions and rate-limit counters. Eager connect, offline queue
  on. There is no fallback on the credential path.

## Environment validation

Both `apps/api/src/env.ts` and `apps/worker/src/env.ts` parse `process.env`
through Zod **once at boot** and throw with a per-variable message on failure. A
missing or malformed variable is a startup failure, not a runtime surprise —
which matters most for `BETTER_AUTH_SECRET`, where a short secret would
otherwise surface as silently forgeable cookies.

## Health

`/health` reports per-dependency detail in the body **and** changes its status
code — 503 when a dependency is down — so Docker, a load balancer and a human
reading the JSON all reach the same verdict. `/health/live` is the liveness-only
counterpart and touches no dependency (D10).
