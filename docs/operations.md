# Operations

**Read this when** you need to know what runs on a schedule, how something fails,
or how to reset a piece of the stack.

## Queues

Four BullMQ queues on the cache Redis, all produced by `apps/api` and consumed
by `apps/worker`. Default job options: 3 attempts, exponential backoff from 5 s,
last 100 completions and 500 failures retained.

| Queue           | Jobs                                                            | Concurrency             |
| --------------- | --------------------------------------------------------------- | ----------------------- |
| `images`        | `process-image`                                                 | `IMAGE_CONCURRENCY` (3) |
| `fuel-prices`   | `scrape-fuel-prices`                                            | 2                       |
| `notifications` | `enquiry-message`                                               | 2                       |
| `maintenance`   | `cleanup-images`, `reconcile-images`, `reconcile-notifications` | 1                       |

`notifications` runs at 2 rather than the default: SMTP servers rate-limit, and
a burst of parallel sends is the fastest way to be told so. Nothing is waiting
on it — that is why the job exists at all (D68).

`sharp.concurrency(1)` is set in the worker on purpose. libvips is itself
threaded, so left alone N concurrent jobs become N × cores threads and the
container thrashes. One libvips thread per job, with BullMQ controlling how many
jobs run, keeps memory and CPU predictable — which is the entire reason this work
is not in the API.

## Schedules

| Schedule                 | Cadence            | Env                            | What it does                                    |
| ------------------------ | ------------------ | ------------------------------ | ----------------------------------------------- |
| `fuel-prices-hourly`     | hourly on the hour | `FUEL_SCRAPE_CRON`             | Scrapes petrol/diesel/CNG per city              |
| `image-cleanup`          | hourly at :17      | `IMAGE_CLEANUP_CRON`           | Sweeps abandoned uploads and orphaned originals |
| `image-reconcile`        | every 60 s         | `IMAGE_RECONCILE_INTERVAL_MS`  | Drains `PENDING` rows nothing is processing     |
| `notification-reconcile` | every 120 s        | `NOTIFY_RECONCILE_INTERVAL_MS` | Sends enquiry mail the enqueue missed           |

Both reconcilers use `every` rather than a cron pattern: cron's finest
granularity is a minute anyway, and `every` keeps the interval honest across
restarts. Both are silent when there is nothing to do, which is almost always.

The notification one is slower on purpose. The image reconciler's interval is
set by how long somebody will stare at a spinner; a dropped notification is
invisible to everyone, so nobody is waiting and the scan can be cheaper (D68).

Schedules are registered with `upsertJobScheduler`, so a restart does not
duplicate them and a changed cadence takes effect on the next boot.

## Failure modes

The governing rule: **a free tier refusing is an ordinary state, not an
exception.** Nothing in a request path throws because an upstream said no.

| Failure                       | What happens                                                                                                   | What the user sees                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Redis down                    | Cache commands reject immediately (no offline queue). Every caller falls back to Postgres or a degraded answer | Slower, complete results                             |
| Redis down (auth)             | The auth connection queues through the reconnect — there is no fallback on a credential path                   | A brief pause, then normal                           |
| Nominatim down or importing   | Tier 2 returns nothing; tier 1 still answers from `pg_trgm`                                                    | Local suggestions, a "wider search unavailable" note |
| OSRM down or graphs not built | Route is null; commute cost degrades to straight-line distance, flagged                                        | Distances marked as estimates                        |
| Overpass 429                  | Cached-or-empty with `degraded: true`                                                                          | "Couldn't refresh nearby places", not "none nearby"  |
| Fuel scrape fails             | Cache untouched; API reads `FuelPrice` from Postgres with a `staleAt`                                          | Prices with an "as of" timestamp                     |
| Image enqueue fails           | The row is committed anyway; the reconciler drains it within ~2 minutes                                        | A brief spinner, then the photo                      |
| Image genuinely unprocessable | `REJECTED` (the file) or `FAILED` after retries, both with a reason                                            | An actionable message in the wizard                  |
| Postgres down                 | `/health` answers 503 with per-dependency detail                                                               | An error page — this one really is fatal             |

`degraded` never means "empty". "We could not refresh this" and "there is nothing
here" are different answers, and to someone choosing where to live they are
opposite ones.

## Resetting things

**The database** — drop, re-migrate, re-seed:

```bash
pnpm db:reset
```

`prisma migrate reset` no longer seeds in Prisma 7, so `db:reset` chains
`db:seed` explicitly. It also refuses to run when it detects an AI agent and
demands an explicit consent variable; that is deliberate on Prisma's part.

Without `reset` at all (see [data-model.md](data-model.md) for the exact
commands): drop and recreate the `public` schema, re-run the extension init
script, then `db:deploy && db:seed`.

**Object storage** — the seed rewrites the shared fixture variants on every run.
To start clean:

```bash
docker compose down -v minio && docker compose up -d minio minio-init
```

**Queues** — a wedged queue, in `redis-cli`:

```bash
docker compose exec redis redis-cli --scan --pattern 'bull:images:*' | head
docker compose exec redis redis-cli DEL bull:images:meta   # last resort
```

Prefer letting the reconciler and the cleanup job do their work: between them,
a lost job and an abandoned upload both resolve on their own.

**Everything** — `docker compose down -v` removes the volumes too, which means
the Nominatim import repeats (tens of minutes) and the OSRM graphs rebuild. Use
`docker compose down` unless you actually want that.

## The whole stack, checked

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
docker compose ps                        # every service (healthy)
curl -s localhost:4000/health | jq       # 200, per-dependency detail
curl -s localhost:4100/health | jq       # worker: queues running
curl -s 'localhost:4000/api/places/suggest?q=korama' | jq '.sources'
```

`pnpm typecheck` is a hard gate and covers every package plus the root-level
`prisma.config.ts` and `scripts/` via `tsconfig.tools.json`. CI runs typecheck,
lint, format, test and build as separate steps, plus `pnpm auth:check`.

## Tests, and what they run against

Nothing important is mocked.

| Suite               | Runs against                      | Why not a mock                                               |
| ------------------- | --------------------------------- | ------------------------------------------------------------ |
| `packages/shared`   | real sharp                        | The point is what libvips actually does to real bytes        |
| `packages/db`       | real PostGIS                      | `ST_DWithin`, ring arithmetic, KNN ordering and the trigger  |
| `apps/api`          | real PostGIS                      | Ownership, cascades, the publish gate, the role upgrade      |
| `apps/api` (places) | real PostGIS + a stubbed geocoder | Trigram behaviour is the subject; Nominatim is not           |
| `apps/api` (guards) | an injected fake session resolver | Guards should need no infrastructure at all                  |
| `apps/worker`       | real PostGIS + real Redis         | `getJob`, job states and id collisions are where the bug was |

`TEST_DATABASE_URL` wins when set (CI provides a PostGIS service container);
otherwise a throwaway testcontainer is started. The developer's own
`DATABASE_URL` is never used — these suites truncate tables.
