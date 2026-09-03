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
question).

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

| Service   | Self-hosted here                        | Public fallback                  | Limit                                          | Swap-out                                              |
| --------- | --------------------------------------- | -------------------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| Nominatim | `mediagis/nominatim:5.3`, `geo` profile | `nominatim.openstreetmap.org`    | 1 req/s, needs a real contact in the UA        | New `GeocodeProvider`, add a `GEOCODE_PROVIDER` value |
| OSRM      | `osrm/osrm-backend:v5.25.0` x2          | `router.project-osrm.org` (demo) | Demo server, no SLA, `ALLOW_PUBLIC_OSRM` gated | New `RoutingProvider`                                 |
| Overpass  | not self-hosted                         | `overpass-api.de` and mirrors    | ~10k queries/day, 429s under load              | New `PoiProvider`; or self-host Overpass              |
| Tiles     | not self-hosted                         | `tiles.openfreemap.org`          | Free, no key, fair use                         | `VITE_MAP_STYLE_URL`                                  |

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

Seven categories, fixed: hospital, police, school, pharmacy, atm, supermarket,
transit. Fixed rather than open because they are one batched query, one legend
and one set of icon layers, and each of those has to know the whole set up front.

**One batched query per listing**, not one per category — a free Overpass mirror
will rate-limit seven sequential requests where it tolerates one. Cached 24 h.

On a 429 or a timeout the lookup returns cached-or-empty with `degraded: true`
rather than failing the request. The sidebar then says "couldn't refresh nearby
places" instead of "none nearby", because those mean opposite things.

## OSM data pipeline

`scripts/bootstrap.sh`, idempotent, everything in containers (D28):

1. Download the three Geofabrik India **zone** extracts covering the seed cities.
   Geofabrik publishes India by zone, not by state — the per-state URLs the brief
   assumed return an HTML error page, which fails much later as a corrupt
   download (D27). Patna → `eastern-zone`, Bengaluru → `southern-zone`, Pune →
   `western-zone`; ~1 GB, cached in `.osm-cache/`.
2. Cut each city out by bounding box with `osmium` (`iboates/osmium:1.19.0`).
3. Merge the three cuts into one `osm-data/merged.osm.pbf`, a few MB.
4. Delegate the OSRM graph build to the `osrm-init` compose service, so the
   pipeline is defined once.
5. Nominatim imports the same file on first boot.

On Windows the mount paths go through `cygpath -m` with `MSYS_NO_PATHCONV=1`,
because Docker Desktop wants `C:/...` and Git Bash would otherwise rewrite
`/cache` into a host path.
