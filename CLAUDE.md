# CLAUDE.md — Machiya / RentNear

Standing rules for every session in this repo. Read this first, then orient from
the repo itself. A feature prompt tells you _what_ to build; this file tells you
_how_ work is done here, and it outranks convenience.

## What the product is

A house-hunter sets their office location on a map. The app shows every rental or
for-sale listing within 3 km, drawn inside labeled 1/2/3 km rings. Clicking a
listing draws the real road route from the office, opens a detail sidebar,
highlights nearby hospitals, police stations, schools and transit, and computes a
live monthly commute cost from scraped fuel prices and the actual road distance.
Listings can then be ranked by rent plus commute — total true monthly cost —
which is the differentiator. Property owners get an Airbnb-style dashboard to
list their properties with photos, pricing, amenities and enquiry management.

Seed cities: Patna, Bengaluru, Pune.

## Orientation, every session

Read in this order before touching anything:

1. `DECISIONS.md` (root) — every non-obvious choice and its reasoning.
2. `docs/README.md` and the documents it indexes.
3. `docs/audit.md` — brief-versus-reality state.
4. Root and per-workspace `package.json` scripts — the commands.
5. `docker-compose.yml` and `prisma/schema.prisma`.

Entries in `DECISIONS.md` are settled and verified. Do not re-litigate one
unless you find code that contradicts it — in which case rewrite that entry in
place rather than appending a contradiction.

## Non-negotiable constraints

Every dependency is free or self-hostable. No Google Maps, no Mapbox, no paid
geo APIs, no hosted auth SaaS, no paid email SDK. Before adding any dependency
or service, confirm it is free or self-hostable; if it is not, propose an
open-source alternative instead of using it.

Self-hosted geo stack: Nominatim (geocoding), OSRM car + bike (routing),
Overpass (POIs), OpenFreeMap tiles, MapLibre GL. All read the same merged
three-city OSM extract. A public endpoint is a fallback, never a default.

## Quality gates

- Conventional commit per numbered item. The repo builds, typechecks and passes
  tests at every commit.
- `pnpm typecheck` exits 0 across every package, including the tools tsconfig.
- Nothing is silenced with `any` or `@ts-expect-error`. If a type is wrong, fix
  the type.
- Run typecheck and build after every item and fix what they report before
  committing.

## DECISIONS.md conventions

- One entry per non-obvious choice, written in the same commit as the change.
- State what you **verified and how** — the command you ran, the output you saw
  — not what you assumed. Several entries exist because an assumption was wrong.
- When an entry is superseded, rewrite it in place. A decisions log that argues
  with itself is a log nobody trusts.
- Diverging from a brief is fine and has happened repeatedly for good reasons.
  Diverging silently is not.

## Docs conventions

`README.md` stays short: what the product is, prerequisites, the commands to get
running, dev credentials, and a table of links into `docs/`. Everything else
lives in `docs/`, each file opening with a one-line "read this when…".

Where a decisions entry and a doc cover the same ground, the doc says how it
works now and links to the entry for why. Do not copy reasoning into both.

## Invariants you must not break

### Prisma + PostGIS

- Geography columns are `Unsupported("geography(Point, 4326)")`, always
  **optional** in the schema (required breaks `Model.create` entirely), with
  presence enforced by a CHECK constraint.
- `lat`/`lng` Floats are the readable pair; `location` is for indexing and
  querying. A `BEFORE INSERT OR UPDATE` trigger keeps them in sync — never
  reimplement that in application code.
- All raw SQL lives in `packages/db/src/geo-queries.ts`. Nowhere else.
- Every coordinate reaching SQL is a bound parameter. Floats need explicit casts
  (`$n::double precision`) — the driver adapter's type inference differs from the
  old Rust engine and will infer `integer` from an Int column on the other side.
- Prisma CLI runs from the repo root with an explicit `--schema`; the root `.env`
  is the single source of environment truth. Connection string lives in
  `prisma.config.ts`.

### Geo correctness

- Derived caches (routes, POIs, forward and reverse geocodes) are keyed by the
  **geo epoch** from `osm-data/manifest.json`. A rebuild changes the epoch and
  stale entries become unreachable without anyone flushing anything.
- **Padded bbox** is what artifacts are cut from. **Unpadded bbox** is what
  "is this locality inside its city" validates against. Never conflate them.
- Every geo entry point — search, office selection, reverse geocode, listing
  create, routing — checks coverage before doing work. An OSRM 400 for
  out-of-graph coordinates is a symptom, not the place to catch it.
- Nearest-centroid fallback is correct inside coverage, for a point in a gap
  between boundaries. Across a coverage boundary it is silent data corruption.
- All city-specific data lives in the city record. Nothing city-specific is
  hardcoded anywhere else. `scripts/validate-cities.ts` runs in CI.

### Auth

- Authorization is server-side. Never trust a role, user id or owner id from the
  client. Every mutation re-checks ownership against the session user unless the
  caller is admin.
- Run `pnpm auth:check` and `pnpm auth:routes` after every Better Auth upgrade or
  plugin change. The CLI's generated schema is a draft, not the truth, and route
  names have been renamed under us before.

### Images

- `sharp` never enters `apps/api`. Derivation runs in the worker only, behind
  `@machiya/shared/images`.
- The declared content type is never trusted; magic bytes decide.
- `originals/` is private, `variants/` is the only publicly readable prefix.
- `ListingImage.variantBaseKey` is the single source of truth for where variants
  live. Do not recompute keys at call sites.
- The PENDING row is the outbox. Enqueue strictly after commit; the reconciler
  drains what the enqueue missed. A real outbox table is justified only when one
  transaction must produce more than one unrelated side effect.

## UI standard

`docs/design.md` is the stated direction; follow it rather than reaching for
shadcn defaults. Price is the loudest element on a card and total-monthly-cost is
the second, because that is the product's argument.

Required on every surface: designed empty states with an illustration and a next
action; skeletons shaped like what is loading, not generic bars; per-route error
boundaries with retry; a toast for every mutation outcome; optimistic mutations
where the outcome is near-certain; and a complete keyboard path including the
list-only fallback view, since a map is not navigable by keyboard.

Copy is honest. Never promise precision the data cannot deliver, and never
apologise for a fast path — a locally-answered query is the good case, not a
degraded one.

## Motion discipline

Motion comes from `motion/react`. Discipline matters more than the effect list:

- Never drive maplibre paint or layout properties from React state at frame rate.
  Animate the camera with the map's own `easeTo`/`flyTo`, and layer properties
  via `requestAnimationFrame` writing through `setPaintProperty`. Reserve
  `motion` for DOM chrome.
- Every animation honours `prefers-reduced-motion` with an instant fallback.
- No animation gates the appearance of content the user is waiting for.
- Test with 60 markers on screen while dragging the office pin. If it drops
  below 60fps, cut the animation rather than the frame rate.

## Verification discipline

Verify current API shapes against live docs before writing against them for:
Prisma 7, Better Auth, Tailwind v4, react-router 7, maplibre-gl 6, motion. Most
of those have already cost this project a debugging session.

When a claim is checkable with a command, check it. `docker manifest inspect` for
image architectures, a container `ls` for a path inside an image, a real query
against the seeded database for search behaviour. Tests that mock the thing whose
behaviour is in question prove nothing.

## Working style

Simplest thing that works: no microservices, no GraphQL, no premature
abstraction. If a decision is ambiguous, pick a sane default, log it in
`DECISIONS.md`, and keep moving rather than stopping to ask.

At the end of each item, print the diff summary, the commands to verify it, and
anything left deliberately undone.
