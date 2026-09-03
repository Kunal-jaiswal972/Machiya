# Geo

**Read this when** you are working on geocoding, routing, POIs or autocomplete —
or one of the free tiers is refusing to answer.

Everything here is free or self-hostable. No Google, no Mapbox, no API keys in
the browser.

## The adapter interfaces

`packages/shared/src/geo/providers.ts` declares three interfaces and nothing
else — it knows nothing about Nominatim, OSRM or Overpass:

| Interface         | Contract                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `GeocodeProvider` | `search(query, opts)` → ranked `GeocodeResult[]`; `reverse(coord)` → one result or **null** |
| `RoutingProvider` | `route({from, to, profile})` → `RouteResult` or **null**                                    |
| `PoiProvider`     | `nearby({center, radiusMeters, categories})` → `PoiLookupResult`                            |

The concrete clients live in `apps/api/src/geo/`. Feature code never imports
them directly — it goes through a resolver (`resolveGeocodeProvider()`), selected
by an env variable — so swapping a provider touches one file.

Two properties every provider must have:

- **It is allowed to fail.** A geocoder still importing, a routing graph not yet
  built, an Overpass mirror answering 429: all ordinary states. Providers return
  "no answer" or set `degraded`; none of them throw into a request path.
- **`degraded` is not `empty`.** "We could not refresh this" and "there is
  nothing here" are different answers, and to someone choosing where to live they
  are opposite ones. The result schemas carry the flag so the UI can say which.

## Tiles

OpenFreeMap's `liberty` style, no key, behind `VITE_MAP_STYLE_URL`. Swapping to
another vector style is one env variable.

maplibre-gl needs one non-obvious fix: its tile-parsing worker is resolved at
runtime from its own module URL, which Vite breaks in both dev and production —
**silently**, with the map painting its background layer and nothing else.
`apps/web/scripts/sync-maplibre-worker.mjs` copies the worker into `public/` and
`src/lib/maplibre-setup.ts` calls `setWorkerUrl()`. Do **not** try to isolate
maplibre with `manualChunks`; that reintroduces the break. Full explanation in
DECISIONS.md D12.

## Autocomplete: two tiers

Office selection is the product's first interaction, so type-ahead has to feel
instant. A round trip to a geocoder per keystroke does not, whoever hosts it.

**Tier 1 — local, `pg_trgm`.** One statement over `City.name`, `Locality.name`
and the `title`/`address` of PUBLISHED listings, served by GIN `gin_trgm_ops`
indexes. Single-digit milliseconds, no network, and relevant to the three cities
this product serves. Two match paths:

- the `%` similarity operator, which is what makes `koramangla` find
  Koramangala;
- a case-insensitive prefix, which is what makes a short query work at all —
  `similarity('Koramangala', 'ko')` is about 0.18, under any useful threshold,
  and `ko` is exactly how someone starts typing it.

A prefix hit scores 0.92 so a true trigram match still outranks it, and listing
rows are multiplied by 0.8: a locality is a better answer to "where is your
office" than a listing whose title happens to contain the word.

**Tier 2 — Nominatim.** Reached only when tier 1 returned fewer than 5 results
**and** the term is at least 3 characters. Cached in Redis for 7 days under a
normalised query (trimmed, lowercased, whitespace-collapsed — otherwise
`Boring Road`, `boring  road` and `BORING ROAD ` are three cache entries for one
question), and under the **geo epoch** — Nominatim answers come from the
imported extract, so a geocode is as derived as a route is. The 7-day TTL reads
like the thing that keeps this honest across a rebuild and is **not**: the
epoch is. See [the geo epoch](#the-geo-epoch-and-the-artifact-manifest).

The client adds the rest of the restraint: a 250 ms trailing debounce, and React
Query's `AbortSignal`, which cancels the in-flight request when the term changes.
The route forwards that abort upstream, so an abandoned keystroke stops work at
Nominatim rather than merely being ignored on arrival.

**One endpoint, one list.** `GET /api/places/suggest` merges the tiers on a
single 0-1 score scale with a `source` per row. De-duplication is by normalised
label plus coordinates rounded to ~100 m, and on a collision **the local row
wins regardless of score** — it is the one carrying a `citySlug` and, for a
listing, a slug, which is what the UI needs to act on a selection. Two
Koramangalas 300 km apart still both appear.

`degraded: true` means exactly one thing: tier 2 was needed and answered nothing.
Tier 1 being sufficient is the fast path, not a degradation.

Reasoning and the verified numbers: DECISIONS.md D39.

## Geocoding: Nominatim

`mediagis/nominatim:5.3`, importing the merged three-city extract directly, in
the `geo` compose profile. It serves `/search` and `/reverse`.

`GEOCODE_PROVIDER` exists with `nominatim` as its only value, so provider
selection stays explicit and swappable rather than hardcoded.

Two things about the service that fail slowly and invisibly, both verified:

- the Postgres cluster inside the image is **16**, so
  `nominatim-data:/var/lib/postgresql/16/main` really is the cluster directory.
  Mount it anywhere else and the multi-minute import silently repeats on every
  recreate.
- there is deliberately **no flatnode volume**. `FLATNODE_FILE` is a file path,
  not a directory, and three city extracts are nowhere near large enough to need
  one. An earlier version mounted a volume at `/nominatim/flatnode` with the
  variable unset — an inert mount implying a tuning knob that was not in use.

**Photon was evaluated and removed**, not deferred. It cannot read an
`.osm.pbf`; its only import source is a Nominatim database it would duplicate;
there is no official image; and the per-country prebuilt indexes 404, leaving
only the 101 GB planet index. The one thing it would have bought — type-ahead
latency — is better served locally by tier 1 above. Full reasoning: D26.

### Free-tier limits and the swap-out path

| Service   | Self-hosted here                                 | Public fallback                  | Limit                                            | Swap-out                                              |
| --------- | ------------------------------------------------ | -------------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| Nominatim | `mediagis/nominatim:5.3`, `geo` profile          | `nominatim.openstreetmap.org`    | 1 req/s, needs a real contact in the UA          | New `GeocodeProvider`, add a `GEOCODE_PROVIDER` value |
| OSRM      | `osrm/osrm-backend:v5.25.0` x2                   | `router.project-osrm.org` (demo) | Demo server, no SLA, `ALLOW_PUBLIC_OSRM` gated   | New `RoutingProvider`                                 |
| Overpass  | `wiktorn/overpass-api:v0.7.62.11`, `geo` profile | mirrors (NOT `overpass-api.de`)  | fallback only; ~10k queries/day, 429s under load | New `PoiProvider`                                     |
| Tiles     | not self-hosted                                  | `tiles.openfreemap.org`          | Free, no key, fair use                           | `VITE_MAP_STYLE_URL`                                  |

`NOMINATIM_USER_AGENT` must carry a real contact address **before** pointing
`NOMINATIM_URL` at the public instance — it rejects requests without one, and
the policy is the price of the free tier.

`ALLOW_PUBLIC_OSRM` is a local escape hatch for when the graphs are not built
yet. It must stay `false` in production; a route from the demo server is marked
`degraded` so the UI never presents it as measured fact.

## Routing: OSRM

Two `osrm-routed` services from the same merged extract, one car graph and one
bicycle graph. Real road distance and duration, cached 24 h.

`osrm-routed` **ignores the profile segment in the URL** — the graph it was
given decides the profile. So both healthchecks use `/route/v1/driving/...`; an
earlier `/route/v1/bike/...` implied a distinction that does not exist.

The images are `linux/amd64` only (verified with
`docker manifest inspect --verbose`, which returns a single manifest rather than
a manifest list), hence `platform: linux/amd64` on all three services.
`OSRM_CAR_PORT` defaults to **5100** because 5000 is AirPlay Receiver on macOS.

`osrm-init` builds both graphs on first run, skips a graph whose
`.osrm.mldgr` already exists, and refuses to start with a message naming
`pnpm bootstrap` when `/data/merged.osm.pbf` is absent — rather than dying inside
`osrm-extract` with an opaque libosmium error.

Road distance is what the commute-cost engine uses. Straight-line `ST_Distance`
is for ring arithmetic only, never for cost.

## POIs: Overpass

**Self-hosted**, `wiktorn/overpass-api:v0.7.62.11` in the `geo` profile,
initialised from the same `osm-data/merged.osm.pbf` that OSRM and Nominatim
read. A public mirror is reachable through `OVERPASS_URL` but is a **fallback,
never the default** — the mirrors explicitly ask people not to build products
against them, and POIs from planet-current data sitting next to routing from a
fixed extract let a listing's road graph and its nearby-hospital list disagree
about what exists. Full reasoning: DECISIONS.md D48.

Seven categories, fixed: hospital, police, school, pharmacy, atm, supermarket,
transit. Fixed rather than open because they are one batched query, one legend
and one set of icon layers, and each of those has to know the whole set up
front.

**One batched query per listing**, not one per category. The rule outlived the
fair-use argument it was made for: seven queries are seven `around:` scans over
the same neighbourhood and seven round trips, and the panel would fill in seven
steps instead of appearing at once.

Cached 24 h, with a second two-week copy under a `:stale` key. The reason is
now query cost, not politeness — and the stale copy is what makes the geo
profile being down a _degraded_ panel instead of an empty one.

### Service configuration, and why each setting

| Setting                                  | Why                                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `OVERPASS_MODE=init`                     | Build from our own extract rather than cloning someone's database.                                                                       |
| `OVERPASS_PLANET_URL=file:///osm/...pbf` | curl handles `file://`, so it is literally the same file the other two services read.                                                    |
| `OVERPASS_PLANET_PREPROCESS`             | Overpass's init reads OSM XML, not PBF. The image ships `osmium`, so the conversion happens in place.                                    |
| `OVERPASS_META=no`                       | Changeset ids and user attribution are dead weight for a POI lookup and roughly halve the database.                                      |
| `OVERPASS_USE_AREAS=false`               | Nothing here uses `area` or `is_in` — every query is `around:` — and area generation is a large slice of both init and the updater loop. |
| `OVERPASS_DIFF_URL` **unset**            | Diff updates disabled entirely. A fixed snapshot is a feature: screenshots and bug reports have to be comparable across machines.        |
| no `platform:` pin                       | Verified with `docker manifest inspect`: this image publishes **both** linux/arm64 and linux/amd64, unlike OSRM.                         |

The healthcheck runs a **real interpreter query**
(`node(1);out ids;`), not a port probe: the HTTP listener answers long before
the database is queryable, so a port check reports healthy in the middle of an
import and lets the API serve empty POI sets. `start_period` is 45 minutes so a
cold init is not mistaken for a wedged container.

### The cold read, and what `degraded` means now

A cold read starts a warm and waits `OVERPASS_COLD_WAIT_MS` (default 3 s) for
it. Against the local instance the wait is what happens: the query returns and
the panel is simply populated. The bound is what stops that from becoming a
dependency — an importing or wedged Overpass degrades the panel instead of
holding a request open, and the client polls every 8 s while the answer is
degraded and empty.

The warm is not tied to the request's abort signal on purpose: it outlives the
request, so a user who closes the sidebar still leaves the cache warm.

`degraded: true` no longer means "a mirror rate-limited us". It means one thing:
**the geo profile is not up** (or is still importing). The panel says "could not
refresh" rather than "none nearby", and in development it names the command that
fixes it.

Query failures are ordinary error handling now. The old 429/504 special case
existed to be polite to a shared service; a local instance either answers or is
down, and the caller degrades identically either way.

### `qt` is load-bearing

The query ends `out center tags qt;`. Measured against a public mirror
(DECISIONS.md D42): the same seven-category query answered in 38 s with
quadtile ordering and had not returned after 60 s without it. It stays against
the local instance too — ordering by id is work nobody asked for, and the
client re-sorts by distance regardless.

### If you must use a public mirror

Set `OVERPASS_URL` and raise `OVERPASS_TIMEOUT_MS` to 90000. **Not
`overpass-api.de`**: it answers 406 Not Acceptable to every User-Agent tried
except curl's own — verified across four UAs with the identical query, and
spoofing curl to get past a mirror's own policy is not a fix. Mirrors that do
accept a descriptive UA: `https://overpass.kumi.systems/api/interpreter`,
`https://overpass.private.coffee/api/interpreter` (504'd under this load here),
`https://overpass.osm.jp/api/interpreter`.

Expect the panel to go back to answering degraded-then-polling, because a
public mirror does not return inside the cold-wait bound.

### The abort-signal trap

All three geo providers pass `AbortSignal.any([caller, AbortSignal.timeout(ms)])`.
Passing only the caller's signal — which is the request-close signal — silently
**removes** the timeout, and a slow mirror then held a request open past 45
seconds instead of degrading at 25. If you add a fourth provider, combine the
signals.

## Two bounding boxes per city

Each city in `scripts/cities.ts` carries two boxes, and they are not
interchangeable:

| Box          | What it is                           | What reads it                                           |
| ------------ | ------------------------------------ | ------------------------------------------------------- |
| `bbox`       | the administrative box, hand-written | "is this locality inside its city", city-overlap checks |
| `paddedBbox` | `bbox` grown by 9 km, **derived**    | `osmium extract` — everything downstream is cut from it |

The padding is not a safety margin, it is a correctness requirement. With a
3 km search radius around an arbitrary office:

- a listing near an edge gets a **truncated** POI answer — half a 1.5 km circle
  with no data in it, reported as "3 schools nearby" rather than "the map stops
  here";
- a **route** is bounded by neither radius. A road can leave the box and come
  back, and a graph that ends mid-carriageway answers either `NoRoute` or an
  absurd detour — the second being worse, because it looks measured.

`paddedBbox` is computed by `padBbox()` and attached to every city once, so no
caller can cut an artifact from the administrative box by mistake. Do not write
it out by hand; two boxes maintained separately drift, and the drift reads as a
data bug in whichever you check second.

`pnpm tsx scripts/cities.ts extracts` prints the **padded** boxes (bootstrap
cuts with these); `... bboxes` prints the administrative ones.

Reasoning, and what the tight cut actually broke: DECISIONS.md D47.

## The geo epoch and the artifact manifest

Routes, POIs and geocodes are all derived from the OSM artifacts. A cached
entry is therefore only valid for the artifacts that produced it: after a
re-cut with different bounds, the same key names a different — and wrong —
answer.

So every derived Redis key is prefixed with a **geo epoch**: a 12-character
hash of the artifact-relevant city config (slug, zone, bboxes) plus the sha256
of every source zone extract. `scripts/bootstrap.sh` writes it into
`osm-data/manifest.json` as its last step; the API reads it once at boot and
`geoCacheKey()` puts it in front of every route, POI and geocode key.

```
<epoch>:route:car:25.6127,85.1145:25.5941,85.1376
<epoch>:poi:12.9352,77.6245:1500:all
<epoch>:geocode:koramangala:bengaluru:8
```

A rebuild changes the epoch and every derived entry becomes unreachable —
**nobody has to flush Redis**, and a partial rebuild on one machine cannot
serve another machine's geometry. The orphaned keys expire on their own TTL.

What is deliberately NOT prefixed: `view:{listingId}:{viewerHash}`. A view
dedupe window has nothing to do with OSM data, and prefixing it would turn
every artifact rebuild into a spike in view counts.

With no manifest — a clone that has never run `pnpm bootstrap` — the epoch is
the literal `unbuilt`, logged at warn with the path it looked in. The core
stack has to be usable before the artifacts exist (D6), so this cannot be
fatal; it must not be silent either.

Useful commands:

```bash
pnpm geo:manifest                        # rewrite osm-data/manifest.json (bootstrap's last step)
pnpm tsx scripts/geo-manifest.ts print   # show it, or say it is missing
```

Reasoning and what was verified: DECISIONS.md D46.

## OSM data pipeline

`scripts/bootstrap.sh`, idempotent, everything in containers (D28):

1. Download the three Geofabrik India **zone** extracts covering the seed cities.
   Geofabrik publishes India by zone, not by state — the per-state URLs the brief
   assumed return an HTML error page, which fails much later as a corrupt
   download (D27). Patna → `eastern-zone`, Bengaluru → `southern-zone`, Pune →
   `western-zone`; ~1 GB, cached in `.osm-cache/`.
2. Cut each city out by its **padded** bounding box with `osmium`
   (`iboates/osmium:1.19.0`). Each cut is stamped with the bounds it was made
   with, so changing a bbox re-cuts instead of being skipped as "already
   present" — which is how an unpadded cut used to survive a re-run.
3. Merge the three cuts into one `osm-data/merged.osm.pbf`, a few MB.
4. Delegate the OSRM graph build to the `osrm-init` compose service, so the
   pipeline is defined once.
5. Nominatim and Overpass both import the same file on first boot, each into
   its own volume. Neither has a separate import command: start it and wait.
6. Write `osm-data/manifest.json`: the checksums of every input and output, and
   the geo epoch derived from them.

On Windows the mount paths go through `cygpath -m` with `MSYS_NO_PATHCONV=1`,
because Docker Desktop wants `C:/...` and Git Bash would otherwise rewrite
`/cache` into a host path.
