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
mandatory — so this also removes work from the eventual v7 upgrade.

### D4. All Prisma CLI commands run from the repo root

`packages/db` owns the schema, the client, and (from step 2) every line of raw
SQL. But the CLI is invoked from the root via `pnpm db:*` scripts with an
explicit `--schema` path, so the root `.env` is the single source of environment
truth. Running the CLI inside `packages/db` would make it look for a second
`.env` there and silently diverge from what the apps use.

### D5. Spec-named major versions are honoured even where a newer major exists

The brief pins react-router v7, Prisma 6, and ESLint 9. At scaffold time
react-router 8, Prisma 7, and ESLint 10 were all released. The pins were kept:
the brief is the contract, and a mid-scaffold major bump costs more than the new
features are worth right now. Upgrade path, when it is wanted: react-router 8
drops the `react-router-dom` shim (already unused here — imports come from
`react-router` and `react-router/dom`), and Prisma 7 requires exactly the
generator shape chosen in D3.

Related: Vite 7 rather than 8, because `@vitejs/plugin-react` 6 (the version Vite
8 requires) pulls in oxc/rolldown peers that are churning. TypeScript 5.9 rather
than 7, because `typescript-eslint` 8 targets the 5.x compiler.

### D6. Geo services sit behind a compose `geo` profile

Photon and OSRM cannot start until `scripts/bootstrap.sh` has produced the merged
three-city OSM extract and built their indexes. Leaving them in the default
profile would make a fresh `docker compose up` fail on a clean clone. So:
`docker compose up -d` brings up the core stack, `docker compose --profile geo up -d`
adds routing and geocoding once the artifacts exist.

### D7. `node:22-bookworm-slim`, not Alpine, for the API and worker images

Prisma's query engine ships glibc binaries by default; Alpine needs explicit
`binaryTargets = ["linux-musl-openssl-3.0.x"]` plus `libc6-compat`, which is a
recurring source of "works locally, broken in Docker". The size difference does
not justify the failure mode. The web image is a different story — it is static
files behind `nginx:alpine`.

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
