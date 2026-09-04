# Adding a city

**Read this when** you are adding a fourth (or fortieth) city, or you want to
know what "one entry in the city config" actually costs.

This is not a design sketch. Hyderabad was added on a scratch branch, every
step was timed, and the checklist below is what actually resulted. The city
itself was **not** committed — only this document and the two code changes the
exercise forced.

## The short version

One entry in `CITY_INPUTS` (`packages/shared/src/cities/config.ts`), then a
rebuild. Nothing else in the repo is city-specific: `grep -rniE
'\b(patna|bengaluru|pune)\b' apps packages --include=*.ts --include=*.tsx`
returns the config, the generated boundaries, two doc comments using Bengaluru
as an example, and `VITE_DEFAULT_CITY`'s default — which is a preference, not a
constraint.

What is **not** automatic is the data: four artifacts have to be rebuilt, and
two of them can only be rebuilt by dropping a volume. That is the honest cost,
and `pnpm geo:status` prints it.

## The checklist

### 1. Add the record — 5 minutes

```ts
{
  slug: 'hyderabad',            // lowercase, kebab-case: it goes in URLs
  name: 'Hyderabad',
  state: 'Telangana',
  zone: 'southern-zone',        // which Geofabrik India zone contains it (D27)
  centroid: { lat: 17.385, lng: 78.4867 },
  bbox: { minLng: 78.29, minLat: 17.29, maxLng: 78.6, maxLat: 17.52 },
  defaultFuelType: 'PETROL',
  transitFare: { currency: 'INR', baseFare: 10, perKm: 1.3, minFare: 10, notes: '…' },
  localities: [ /* at least 3, with coordinates inside the bbox */ ],
  fuelSlugs: { goodreturns: 'hyderabad', mypetrolprice: 'hyderabad', ndtv: 'hyderabad' },
}
```

`paddedBbox` and `boundary` are **derived** — do not write them (D47, D50).

A fourth city does not necessarily mean a fourth **zone**: Hyderabad is in
`southern-zone`, which Bengaluru already pulls in, so the exercise added zero
bytes of download. See "when the download strategy switches" below.

### 2. Validate — seconds

```bash
pnpm cities:validate
```

Catches a missing field, a fuel source with no slug, a locality with no
coordinates, a locality outside its city's bbox, and two padded extracts
overlapping enough to make city assignment a guess (D49). In the exercise it
passed with one warning — no boundary polygon yet, which step 5 fixes.

### 3. Cut and merge — about 100 seconds

```bash
pnpm bootstrap
```

Measured, with the zone extract already cached:

| Step                         | Time | Result                       |
| ---------------------------- | ---- | ---------------------------- |
| `osmium extract` (Hyderabad) | 87 s | 34 MB                        |
| `osmium merge` (4 cities)    | 9 s  | 100 MB (was 66 MB for three) |

The cut is stamped with its bounds, so an existing city whose bbox has not
changed is skipped and a changed one is re-cut (D47).

### 4. Rebuild the OSRM graphs — about 2 minutes

`bootstrap` runs `osrm-init`, which compares the extract's sha256 against the
one stored beside each graph and rebuilds when they differ. Measured on the
4-city extract: **65 s for the car graph**, producing **1.0 GB** of graph files;
the bicycle graph is comparable, so budget 2-3 minutes for both.

### 5. Re-import Nominatim and Overpass — about 12 minutes, and **manual**

This is the part that is not one command, and the reason is structural: both
images import their planet file on **first boot only**, into their own volume.
There is no re-import command, so re-importing means dropping the volume.

```bash
docker compose --profile geo rm -sf nominatim && docker volume rm machiya_nominatim-data
docker compose --profile geo rm -sf overpass  && docker volume rm machiya_overpass-db
pnpm bootstrap
```

`pnpm geo:status` prints exactly those commands, so nobody has to remember
them. Measured on the three-city extract: **Nominatim ≈ 8 minutes**, **Overpass
≈ 4 minutes**. Both scale with extract size, so four cities is roughly 15
minutes of wall clock.

### 6. Derive the boundary polygon — seconds

```bash
pnpm cities:boundaries    # needs the geo profile up
```

Writes `packages/shared/src/cities/boundaries.generated.ts`. **Commit it** — the
seed reads that file, not Nominatim, so a machine with no geo profile still
seeds identical geometry (D50).

Check the output rather than trusting it. The script tries three lookups and
rejects any candidate that does not contain the configured centroid or covers
less than a quarter of the configured bbox — because on the first real run
Nominatim answered "Pune, Maharashtra" with a housing society, four buildings
and a shop, all of them valid polygons. What the three seed cities actually
resolved to:

| City      | Source                                | Points     | Area    |
| --------- | ------------------------------------- | ---------- | ------- |
| Patna     | `way/383774533`, settlement search    | 2000 → 628 | 136 km² |
| Bengaluru | `relation/7902476`, settlement search | 4981 → 335 | 716 km² |
| Pune      | `relation/10351626`, reverse lookup   | 345 → 193  | 312 km² |

Patna Municipal Corporation is about 136 km² and BBMP about 709 km², so the
first two are the real municipal boundaries. **Pune is the one to know about**:
the city is mapped only as a _node_ in this extract, so the fallback resolved
the enclosing "Pune City Subdistrict" relation instead — larger than the
municipal boundary, and deliberately accepted. A slightly generous boundary
still answers "which city is this listing in" correctly; the alternative is the
nearest-centroid guess.

### 7. Seed and verify — under a minute

```bash
pnpm db:seed
pnpm geo:status     # every row should read ok
curl -s localhost:4000/health/geo | jq .
```

`/health/geo` answers 503 while the artifacts predate the running config, which
is the state between steps 1 and 5. That is the point of it: a newly added city
cannot serve empty results while everything reports healthy (D51).

## What is unavoidably manual

Four things, and only the first two are structural:

1. **The Nominatim volume drop.** First-boot import only; no re-import command.
2. **The Overpass volume drop.** Same.
3. **Choosing the bbox and the localities.** Judgement, not derivation — the
   validator checks they are consistent, not that they are good.
4. **Reviewing the derived boundary.** Automated with plausibility checks after
   the Pune surprise above, but a polygon that passes both checks can still be
   the wrong administrative level, and only a human notices that.

## What the exercise changed in the code

Two things, both now on `main`:

- **`geo:status` reported downstream artifacts as `ok` while the config was
  stale.** With Hyderabad added, the manifest row correctly said "the artifacts
  predate the running city config" while the OSRM, Nominatim and Overpass rows
  all said `ok` — true of the extract they were built from, and misleading
  about the question being asked. Those rows now report `stale` with "built
  from the current extract, which predates the city config".
- **The boundary fetcher had no plausibility check.** It wrote a housing
  society as Pune's boundary. It now requires the centroid to be inside and the
  bbox coverage to be at least 25%, and it logs every rejection.

## When the download strategy switches

Per-zone extracts up to three zones; `india-latest.osm.pbf` at four or more.
The zones covering the seed cities are 236 MB, 533 MB and 210 MB — about 1 GB —
against roughly 1.4 GB for the whole country, so the fourth zone is where the
sum crosses. `planDownloads()` decides automatically and logs which it picked
and why; the manifest records it (D51).

Note again that this is about **zones**, not cities: a dozen cities inside three
zones still downloads three files.

Beyond that point the binding constraint stops being download size and becomes
**OSRM graph RAM**. `osrm-extract` and `osrm-customize` hold their working set
in memory, and the 4-city extract already produced a 1.0 GB graph directory from
a 100 MB extract; the whole-country extract needs more than a laptop has. The
answer past a handful of cities is a build host, not a bigger download.
