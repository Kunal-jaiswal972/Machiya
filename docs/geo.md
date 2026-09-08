# Geo

**Read this when** you are working on geocoding, routing, POIs or autocomplete —
or one of the free tiers is refusing to answer.

Everything here is free or self-hostable. No Google, no Mapbox, no API keys in
the browser.

## The adapter interfaces

`packages/shared/src/geo/providers.ts` declares three interfaces and nothing
else — it knows nothing about Nominatim, OSRM or Overpass:

| Interface         | Contract                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `GeocodeProvider` | `search(query, opts)` → `{ results, refused }`; `reverse(coord)` → one result or **null** |
| `RoutingProvider` | `route({from, to, profile})` → `RouteResult` or **null**                                  |
| `PoiProvider`     | `nearby({center, radiusMeters, categories})` → `PoiLookupResult`                          |

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
  `GeocodeProvider.search` states it outright with `refused`, because for a
  geocoder the two are indistinguishable from the result array alone — an empty
  list is a real answer about a three-city extract. See DECISIONS.md D54.

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

Tier 2 is asked **free text** rather than a comma-separated structured query,
and on a zero result it retries **once** with a leading house number stripped.
Both are measured decisions; see
[address precision](#address-precision-what-the-extract-actually-holds).

**One endpoint, one list.** `GET /api/places/suggest` merges the tiers on a
single 0-1 score scale with a `source` per row and a `matchPrecision` per row. De-duplication is by normalised
label plus coordinates rounded to ~100 m, and on a collision **the local row
wins regardless of score** — it is the one carrying a `citySlug` and, for a
listing, a slug, which is what the UI needs to act on a selection. Two
Koramangalas 300 km apart still both appear.

The response carries **one** `state` of three — `ok`, `degraded`,
`out_of_coverage` — not a pair of booleans. Tier 1 being sufficient is `ok`: the
fast path, not a degradation. See
[the three autocomplete states](#the-three-autocomplete-states).

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

| Service   | Self-hosted here                                 | Public fallback                 | Limit                                            | Swap-out                                              |
| --------- | ------------------------------------------------ | ------------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| Nominatim | `mediagis/nominatim:5.3`, `geo` profile          | `nominatim.openstreetmap.org`   | 1 req/s, needs a real contact in the UA          | New `GeocodeProvider`, add a `GEOCODE_PROVIDER` value |
| OSRM      | `osrm/osrm-backend:v5.25.0` x2                   | none — see below                | n/a                                              | New `RoutingProvider`                                 |
| Overpass  | `wiktorn/overpass-api:v0.7.62.11`, `geo` profile | mirrors (NOT `overpass-api.de`) | fallback only; ~10k queries/day, 429s under load | New `PoiProvider`                                     |
| Tiles     | not self-hosted                                  | `tiles.openfreemap.org`         | Free, no key, fair use                           | `VITE_MAP_STYLE_URL`                                  |

`GEO_USER_AGENT` must carry a real contact **before** pointing `NOMINATIM_URL`
at the public instance — it rejects requests without one, and the policy is the
price of the free tier. The default is a repository URL, which qualifies; the
old `contact@example.com` placeholder did not, and 403s.

One variable, three callers: Nominatim, Overpass (which answers 406 without a
descriptive agent) and `scripts/fetch-city-boundaries.ts`. It was called
`NOMINATIM_USER_AGENT`, which named only the first of them; the old name is
still honoured so an existing `.env` keeps working. See DECISIONS.md D87.

**There is no public-OSRM fallback, and the two variables that implied one are
gone.** `ALLOW_PUBLIC_OSRM` and `PUBLIC_OSRM_URL` were declared in the API's
env schema and read by nothing: the routing adapter only ever reads
`OSRM_CAR_URL` and `OSRM_BIKE_URL`. When OSRM cannot answer — graphs not built,
container down, genuinely no route — the commute panel falls back to a
straight-line estimate marked `degraded` and says so in words (D43). It never
silently reaches a demo server. A variable that looks like a supported escape
hatch and is not is worse than no variable, which is the same reasoning that
removed the inert Nominatim flatnode mount (D26).

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

## Address precision: what the extract actually holds

**Measured, not assumed.** Every query below was run against the local
Nominatim on the rebuilt three-city extract. The whole design of the fallback
rests on these numbers, so they are recorded rather than described.

### Landmarks resolve — under their OSM name

| Query                                | Result                                        |
| ------------------------------------ | --------------------------------------------- |
| `Golghar Patna`                      | गोलघर, `building/yes`                         |
| `Gandhi Maidan Patna`                | Gandhi Maidan, `leisure/park`                 |
| `Patna Junction`                     | Patna Junction, `landuse/railway`             |
| `Patna Museum`                       | पटना संग्रहालय, `tourism/museum`              |
| `Kempegowda Bus Station Bengaluru`   | Kempegowda Bus Station, `amenity/bus_station` |
| `Shaniwar Wada Pune`                 | Shaniwar Wada, `historic/fort`                |
| `Pune Junction`                      | Pune Junction, `railway/platform`             |
| `Aga Khan Palace Pune`               | Aga Khan Palace, `tourism/attraction`         |
| `Vidhan Sabha Bengaluru`             | **nothing** — it is tagged `Vidhana Soudha`   |
| `Lalbagh Botanical Garden Bengaluru` | **nothing** — `Lalbagh` finds the station     |

So the honest claim is narrower than "landmarks work": a landmark resolves
under the name OSM holds, and a common alternative spelling may not. That is
tier 1's job to soften — a locality or landmark someone actually searches for
belongs in the `Locality` table, where trigram matching forgives the spelling.

### Localities resolve, and tier 1 answers them anyway

All nine locality queries returned something. Two are worth noting because the
**top** result is not the locality: `Kankarbagh Patna` returns Kankarbagh Main
Road (`highway/trunk`) and `Hinjewadi Pune` returns an EV charging station. It
does not matter for office selection, because the seeded localities are tier 1
rows and are answered locally before Nominatim is asked at all.

### House numbers do not resolve. This is the finding the correction rests on

Ten real addresses with house numbers, across the three cities:

- **5 of 10 returned nothing at all.**
- **1 of 10 resolved to an actual `addr:housenumber`** — and it was the wrong
  number: `No 42, 1st Main Road, Indiranagar, Bengaluru` came back as a café at
  housenumber 205.
- the other 4 resolved to the road or the block, which is the useful degrade.

`addr:housenumber` tagging in Indian cities is sparse, and no change of
geocoder fixes that: Nominatim returns what is in the extract, and the
commercial address data that would resolve "House 47, Road 3, Rajendra Nagar" is
exactly what this project excluded on purpose. So the product says what it did
instead of pretending.

### Nonsense returns nothing, which is what makes the above mean something

`Qzxwv Road, Patna` and `zzzzz Bengaluru` both return zero. A fallback that
always found _something_ would be indistinguishable from a fallback that
guessed.

## What happens to an address the geocoder cannot parse

### Tier 1 is already a fuzzy search, and it already degrades

`pg_trgm` similarity over the `Locality` table needs no help with an address —
measured against the seeded database:

| Query                                     | Tier 1's top row        |
| ----------------------------------------- | ----------------------- |
| `House 47, Road 3, Rajendra Nagar, Patna` | Rajendra Nagar, 0.42    |
| `Road 3, Rajendra Nagar, Patna`           | Rajendra Nagar, 0.56    |
| `Flat 4B, 21 Patliputra Colony, Patna`    | Patliputra Colony, 0.56 |
| `Lane 5, Kothrud, Pune`                   | Kothrud, 0.42           |
| `Baner Road, Pune`                        | Baner, 0.38             |

So **there is no stripping in the service**. A pre-stripped second local query
would be a slower way to reach the row trigram already found. What tier 1 cannot
do is answer for a locality that is not one of its rows: `Anisabad`, `Wakad` and
`Bellandur` are real neighbourhoods and all three return only the city.

One thing did need fixing. For the long address forms, listing rows scored level
with the locality and sometimes above it — so an address search would have set
the office to one specific flat. Listings are weighted **0.35 instead of 0.8
when the query reads as a street address**, because someone typing
"80 Feet Road, 4th Block, Koramangala" wants a place on a map, not a flat whose
title contains the word.

### Tier 2 gets free text and, on a dead end, one stripped retry

Two things the adapter does, both from measurement:

- **the `q` is free text, commas collapsed to spaces.** Nominatim matches a
  comma-separated query component by component; free text lets its own fuzzy
  matching work. Across the ten addresses it never did worse and once did much
  better — `#118, 5th Block, Koramangala, Bengaluru` returns a **hotel** with
  commas and `Koramangala 5th Block` (`place/neighbourhood`) without them.
- **on zero results, one retry with the leading house number stripped.** This is
  where the real recovery is: `House 12, Anisabad, Patna` → nothing;
  `Anisabad, Patna` → the neighbourhood. `Flat 3, Bailey Road, Patna` → nothing;
  `Bailey Road, Patna` → the road.

Free text alone does not fix it — eight of the ten returned nothing with or
without commas, so those strings are genuinely absent rather than mis-parsed.
Both are needed, and neither is guesswork about which tokens matter.

**Tier 2 has to actually be reached, which took two more fixes.** Sufficiency is
judged on _confident_ tier-1 rows, not a flat count: a place row counts at any
score, a listing row must clear 0.4. Eight "apartment in Boring Road" rows at
0.117 used to clear a count of five and suppress the tier that knew Bailey Road.
And Nominatim's `importance` is **lifted** onto the 0.25-0.90 band rather than
clipped to a floor — clipping flattened the range everything lands in and let an
alphabetical tiebreak pick the winner. Anything OSM categorises as a `place`
gets a small bonus on top, which is what puts Anisabad Golamber above a
children's park in Anisabad. See DECISIONS.md D60.

**An address we cannot resolve is not an uncovered city.** The out-of-coverage
state requires the query _not_ to read as a street address, because
"221 Sarjapur Road, Bellandur, Bengaluru" resolves to nothing and answering it
with "Machiya covers Patna, Bengaluru and Pune" is a non-sequitur about an
address in Bengaluru. That is the line between this section and the next one.

**One retry, never a loop.** Truncating until Nominatim bites is what turns a
bad query into a confidently wrong answer: strip past the house number on
`47 Road 3 Rajendra Nagar Patna` and the eight results are all the wrong roads,
led by `90 Feet Road`. So the retry fires once and its results are **capped at
`locality` precision** — the house number is gone, so even a building hit is not
the building that was asked about.

The outcome is cached under the normalised **original** query, retry included, so
the same dead-end address costs two upstream calls once rather than twice on
every keystroke that reaches it.

### `matchPrecision`, and the sentence it buys

Every suggestion carries one of three values, derived from what the result **is**
rather than from how it was found:

| Value      | What matched                                 | What the UI says                                            |
| ---------- | -------------------------------------------- | ----------------------------------------------------------- |
| `exact`    | a building, a named POI, a real house number | nothing — the good case needs no note                       |
| `locality` | a neighbourhood, a suburb, or a **road**     | "Showing Rajendra Nagar — drag the pin to your exact spot." |
| `area`     | a city or district                           | "…which covers a wide area — drag the pin…"                 |

A road is `locality` deliberately: finding Bailey Road for "Flat 3, Bailey Road"
means we found the street and not the flat.

### The copy, and why it is worded that way

The office field reads **"Search a landmark, locality or area near your
office"**, not "Enter your address". The second promises precision the data
cannot deliver — one address in ten — and a box that asks for an address and
cannot find one makes a working product feel broken. A one-line hint appears on
first focus only: landmarks and localities work best, and dropping a pin is the
precise option.

Proportionate, too. This sets an **office**. Offices sit in commercial areas
with named buildings and landmarks, and being 200 m out changes nothing about
which listings fall inside a 1/2/3 km ring.

### End to end, against the running stack

Verified through `GET /api/places/suggest` with the geocode cache flushed, so
every row is a fresh answer:

| Query                                     | State             | Top answer                                      |
| ----------------------------------------- | ----------------- | ----------------------------------------------- |
| `Golghar`                                 | `ok`              | Golghar Park — `poi` / **exact**                |
| `Gandhi Maidan`                           | `ok`              | Gandhi Maidan — `poi` / **exact**               |
| `Koramangala`                             | `ok`              | Koramangala — `locality` / **locality**, tier 1 |
| `House 47, Road 3, Rajendra Nagar, Patna` | `ok`              | Rajendra Nagar — **locality**, tier 1           |
| `House 12, Anisabad, Patna`               | `ok`              | Anisabad Golamber — **locality**, tier 2 retry  |
| `Flat 3, Bailey Road, Patna`              | `ok`              | Bailey Road — **locality**, tier 2 retry        |
| `Plot 22, Baner Road, Pune`               | `ok`              | Gopal Hari Deshmukh Marg — **locality**         |
| `221 Sarjapur Road, Bellandur, Bengaluru` | `ok`              | nothing — an address, not a coverage problem    |
| `Qzxwv Road, Patna`                       | `ok`              | Patna — `city` / **area**                       |
| `ahmedabad`                               | `out_of_coverage` | the coverage message                            |

Note the last three. Nonsense degrades to the city as an **area** match rather
than to a wrongly-truncated street; an unresolvable Bengaluru address returns
empty rather than the coverage message; and only a place name that resolves
nowhere gets the coverage message.

Reasoning: DECISIONS.md D58, D59 and D60.

## Coverage: the three cities, as a state the code can see

Every geo entry point asks one question first — **is this a point we can answer
anything about?** — and gets it from one function.

```ts
const resolution = await checkCoverage({ lat, lng }); // apps/api/src/services/coverage.ts
```

The frontier is the **union of the padded bboxes**, taken from
`osm-data/manifest.json` rather than from the city config, because coverage is a
claim about the artifacts and the manifest records what was actually cut. With
no manifest at all the config's boxes are the fallback (D6 again: the core
stack works before `pnpm bootstrap` has ever run).

It is a union **of** rectangles, not the bounding rectangle of the union.
Nagpur is inside the box enclosing Patna, Bengaluru and Pune and inside none of
them; `bboxUnion` is used only for the map's `maxBounds`, and `isInsideAnyBbox`
is what decides membership.

One SQL statement in `packages/db/src/geo-queries.ts` answers three questions in
one round trip: inside any padded envelope, which `City.boundary` covers the
point, and which centroid is nearest with its distance.

### What each entry point does with the answer

| Entry point                 | Inside coverage                    | Outside coverage                                  |
| --------------------------- | ---------------------------------- | ------------------------------------------------- |
| `/api/listings/search`      | `status: "ok"` with the result set | 200, `status: "out_of_coverage"` with the payload |
| `/api/places/suggest`       | `state: "ok"` or `"degraded"`      | `state: "out_of_coverage"` with the payload       |
| `/api/places/reverse`       | `{ place }`                        | `{ place: null, coverage }`                       |
| listing create / patch      | assigned by containment            | **422** `out_of_coverage`, no row written         |
| `/api/listings/:slug/route` | the OSRM route                     | **422** `out_of_coverage`                         |

The reads are 200 because "we do not serve that city yet" is a complete answer;
the writes are 422 because there is nothing sensible to write. The search
response is a **discriminated union** on `status`, so a caller cannot read
`total: 0` off an out-of-coverage response and render "no listings near you".

Never fall back to nearest centroid across the frontier. Inside coverage, for a
point in a gap between a municipal polygon and the edge of the extract, nearest
centroid is correct and stays — labelled `nearest` and logged. Outside, the same
arithmetic files a Mumbai listing under Pune.

### The three autocomplete states

`ok`, `degraded` and `out_of_coverage` are one enum field, not two booleans, and
they mean different things with different fixes:

- **`ok`** — the list is the answer. An empty `ok` inside a covered city means
  the query matched nothing there.
- **`degraded`** — tier 2 was needed and **could not answer**. Local rows still
  stand; the fix is upstream. The adapter reports this as `refused: true`.
- **`out_of_coverage`** — both tiers answered, both empty, and the query reads
  like a place name.

The middle two used to be one value, which is how "we do not cover Mumbai" got
rendered as "the wider search is unavailable". See DECISIONS.md D54.

**Measured, against the local Nominatim, not assumed.** The autocomplete
coverage state fires much less often than "search Mumbai" suggests, because
Indian city names appear all over the covered extracts as road and business
names:

| Query       | State             | Top match                      |
| ----------- | ----------------- | ------------------------------ |
| `mumbai`    | `ok` (7 results)  | Old Pune-Mumbai Highway        |
| `chennai`   | `ok` (6)          | Bengaluru - Chennai Expressway |
| `hyderabad` | `ok` (8)          | Ancient Hyderabad              |
| `jaipur`    | `ok` (2)          | Cottons Jaipur                 |
| `kolkata`   | `ok` (1)          | Kolkata                        |
| `ahmedabad` | `out_of_coverage` | —                              |

Those `ok` answers are correct: the matches are real features inside coverage,
and their context lines say "Pune" or "Bengaluru", so a user who typed "mumbai"
and gets a Pune highway can see that. The coverage message's real home is
therefore the **coordinate** paths — a dropped pin, a shared URL, a saved
office, a listing create — which is where an out-of-coverage point used to do
actual damage. The autocomplete state is a genuine case and a narrower one.

### `GET /api/coverage`

Public, cached hard, ETag stamped with the geo epoch. Returns every served city
with its centroid, both bboxes and its boundary polygon, plus the derived
`maxBounds`.

```bash
curl -s localhost:4000/api/coverage | jq '{epoch, maxBounds, cities: [.cities[].slug]}'
```

The browser reads its city list, its initial camera and the map's `maxBounds`
from here rather than from a build-time constant. **That is what makes "adding a
city is one record" true of the frontend as well** — a fourth city widens the
served set, the pan limit and every coverage message with no code change in
`apps/web`. It is also why `VITE_DEFAULT_CITY` no longer exists.

### "Tell me when you cover Mumbai"

`POST /api/coverage/requests` writes a `CoverageRequest` row — email, the
requested point rounded to about 110 m, and the resolved place label if there
was one — and answers with how many distinct people have asked about somewhere
within 50 km. That table is the signal for which city to add fourth:

```sql
SELECT count(DISTINCT email) AS people,
       round(avg(lat)::numeric, 3) AS lat,
       round(avg(lng)::numeric, 3) AS lng,
       mode() WITHIN GROUP (ORDER BY "placeLabel") AS label
FROM "CoverageRequest"
GROUP BY ST_SnapToGrid("location"::geometry, 0.5)
ORDER BY people DESC;
```

A request for a point already covered is a 409, because a row here is a vote for
a new city. The endpoint sends no mail and is rate limited to 10 per hour per
IP. Reasoning: DECISIONS.md D52-D56.

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

The padded boxes have a third reader now: their union is the **coverage
frontier**, and its bounding rectangle is the map's `maxBounds`, served from
`GET /api/coverage` and derived from the manifest. So a fourth city widens what
the map will let you pan to at the same moment it widens what was cut — nothing
in `apps/web` names a city or a bound.

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
