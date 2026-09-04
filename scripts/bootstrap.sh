#!/usr/bin/env bash
#
# One-time (and re-runnable) setup of the local geo stack for the three seed
# cities defined in scripts/cities.ts.
#
#   1. download the Geofabrik India zone extracts that contain those cities
#   2. cut each city out by its PADDED bounding box with osmium
#   3. merge the cuts into one small .osm.pbf
#   4. build the OSRM car and bicycle graphs from it
#   5. import it into self-hosted Nominatim (geocoding) and Overpass (POIs)
#   6. write osm-data/manifest.json: the checksums of everything above, plus
#      the geo epoch every derived cache key is prefixed with (D46)
#
# Every step is idempotent: anything whose output already exists is skipped, so
# re-running after an interruption costs only what is left. Downloads are cached
# in .osm-cache/ (gitignored) and never re-fetched.
#
# Nothing here needs osmium, osrm or postgres installed on the host — every tool
# runs in a container.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CACHE_DIR=".osm-cache"
OUT_DIR="osm-data"
MERGED="$OUT_DIR/merged.osm.pbf"
GEOFABRIK_BASE="https://download.geofabrik.de/asia/india"
OSMIUM_IMAGE="iboates/osmium:1.19.0"

STARTED_AT=$(date +%s)

# --- output helpers --------------------------------------------------------

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RESET=$(printf '\033[0m')
else
  BOLD=""; DIM=""; RESET=""
fi

step()  { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
info()  { printf '    %s\n' "$1"; }
skip()  { printf '    %sskip: %s%s\n' "$DIM" "$1" "$RESET"; }
die()   { printf '\nerror: %s\n' "$1" >&2; exit 1; }

file_size() {
  if [ -f "$1" ]; then
    du -h "$1" | cut -f1
  else
    printf 'missing'
  fi
}

elapsed() {
  local seconds=$(( $(date +%s) - STARTED_AT ))
  printf '%dm%02ds' $(( seconds / 60 )) $(( seconds % 60 ))
}

# Docker on Windows needs a native path (C:/...), not the MSYS one (/c/...).
host_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s' "$1"
  fi
}

# The image ENTRYPOINT is already osmium, so only the subcommand is passed --
# naming it again yields "Unknown command or option osmium".
osmium() {
  MSYS_NO_PATHCONV=1 docker run --rm \
    -v "$(host_path "$REPO_ROOT/$CACHE_DIR"):/cache" \
    -v "$(host_path "$REPO_ROOT/$OUT_DIR"):/out" \
    "$OSMIUM_IMAGE" "$@"
}

# --- preflight -------------------------------------------------------------

step "Checking prerequisites"
command -v docker >/dev/null 2>&1 || die "docker is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v pnpm >/dev/null 2>&1 || die "pnpm is required (the city list is read from scripts/cities.ts)"
docker info >/dev/null 2>&1 || die "the docker daemon is not running"
info "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'), pnpm $(pnpm --version)"

mkdir -p "$CACHE_DIR" "$OUT_DIR"

# scripts/geo-manifest.ts imports @machiya/shared/cities, and @machiya/shared is
# consumed as built dist (D9) — so build it before anything reads it.
info "building @machiya/shared (the manifest schema and epoch hash live there)"
pnpm -s -F @machiya/shared build

DOWNLOADS=$(pnpm -s tsx scripts/cities.ts downloads)
EXTRACTS=$(pnpm -s tsx scripts/cities.ts extracts)
info "cities: $(pnpm -s tsx scripts/cities.ts slugs | tr '\n' ' ')"

# --- 1. download the source extracts --------------------------------------

step "Downloading Geofabrik extracts"
# Per-zone extracts up to three zones, one whole-country file beyond that: the
# summed zone downloads pass india-latest.osm.pbf at four (D51). The choice is
# automatic because the arithmetic is not a preference, and logged because a
# silent switch from three 200 MB files to one 1.4 GB file reads as a bug in a
# slow-network report.
info "strategy: $(pnpm -s tsx scripts/cities.ts plan)"

for file in $DOWNLOADS; do
  target="$CACHE_DIR/$file"

  if [ -s "$target" ]; then
    skip "$file already cached ($(file_size "$target"))"
    continue
  fi

  info "fetching $file (this is the slow part; it is cached afterwards)"
  # -C - resumes a partial download; write to .part so an interrupted run never
  # leaves a truncated file that later steps would treat as complete.
  # -# is the compact progress bar: the default meter writes a line per update,
  # which turns a piped log into thousands of lines.
  curl -fL -# --retry 3 --retry-delay 2 -C - \
    -o "$target.part" "$GEOFABRIK_BASE/$file"
  mv "$target.part" "$target"
  info "$file: $(file_size "$target")"
done

# --- 2. cut each city out by bounding box ---------------------------------

step "Extracting cities by bounding box"
# `cities.ts extracts` emits the PADDED box (D47), not the administrative one: a
# listing or office near an edge needs road network and POIs on every side, and
# a road route can legitimately leave the box and come back.
#
# Each cut is stamped with the bounds it was made with. Without the stamp, "the
# file exists" meant "skip" — so changing a bbox left every earlier cut in place
# and the pipeline silently kept serving geometry from the old bounds.
CITY_FILES=()
RECUT=0
while read -r slug source min_lng min_lat max_lng max_lat; do
  [ -n "${slug:-}" ] || continue
  target="$CACHE_DIR/$slug.osm.pbf"
  stamp="$CACHE_DIR/$slug.bbox"
  want="$min_lng,$min_lat,$max_lng,$max_lat"
  CITY_FILES+=("/cache/$slug.osm.pbf")

  if [ -s "$target" ] && [ "$(cat "$stamp" 2>/dev/null || true)" = "$want" ]; then
    skip "$slug.osm.pbf already cut at $want ($(file_size "$target"))"
    continue
  fi

  if [ -s "$target" ]; then
    info "$slug bounds changed ($(cat "$stamp" 2>/dev/null || printf 'unstamped') -> $want)"
  fi

  # `source` is resolved by cities.ts, not here: it is the city's zone extract
  # under the zone strategy and india-latest.osm.pbf under the country one, and
  # this loop should not have to know which is in force.
  info "cutting $slug from $source at $want"
  osmium extract \
    --bbox "$want" \
    --set-bounds \
    --overwrite \
    -o "/cache/$slug.osm.pbf" \
    "/cache/$source"
  printf '%s' "$want" > "$stamp"
  RECUT=1
  info "$slug: $(file_size "$target")"
done <<< "$EXTRACTS"

# --- 3. merge into one file -----------------------------------------------

step "Merging city extracts"
if [ -s "$MERGED" ] && [ "$RECUT" -eq 0 ]; then
  skip "merged.osm.pbf already built ($(file_size "$MERGED"))"
else
  [ "$RECUT" -eq 1 ] && info "a city was re-cut, so the merge is redone"
  osmium merge --overwrite -o /out/merged.osm.pbf "${CITY_FILES[@]}"
  info "merged.osm.pbf: $(file_size "$MERGED")"
fi

[ -s "$MERGED" ] || die "merge produced no output"

# --- 4. OSRM graphs --------------------------------------------------------

step "Building OSRM graphs (car + bicycle)"
# The build itself lives in the osrm-init compose service, so the pipeline is
# defined once and `docker compose --profile geo up` can rebuild it too. That
# container skips any profile whose graph was already built FROM THIS EXTRACT —
# it compares the extract's sha256 against one stored in the graph directory, so
# a re-cut with new bounds rebuilds rather than being skipped.
docker compose --profile geo run --rm --no-deps osrm-init

# --- 5. Nominatim and Overpass imports ------------------------------------

step "Importing into Nominatim and Overpass"
# Both images import their planet file on FIRST BOOT into their own volume and
# then serve; neither has a separate import command, so the way to import is to
# start it and wait. A second run finds the volume populated and comes straight
# up. Both read the same merged extract, which is the point: routing, geocoding
# and POIs cannot then disagree about what exists (D48).
docker compose --profile geo up -d nominatim overpass

NOMINATIM_PORT_LOCAL="${NOMINATIM_PORT:-7070}"
OVERPASS_PORT_LOCAL="${OVERPASS_PORT:-12345}"

# A real interpreter query, not a port probe: Overpass answers HTTP long before
# its database is queryable, and a port check would call an import "ready".
overpass_ready() {
  curl -fsS --data-urlencode 'data=[out:json][timeout:5];node(1);out ids;' \
    "http://127.0.0.1:$OVERPASS_PORT_LOCAL/api/interpreter" 2>/dev/null \
    | grep -q elements
}

info "waiting for both to answer (a first import of three cities takes a while)"
nominatim_up=0
overpass_up=0
for attempt in $(seq 1 240); do
  [ "$nominatim_up" -eq 1 ] || if curl -fsS "http://127.0.0.1:$NOMINATIM_PORT_LOCAL/status" >/dev/null 2>&1; then
    nominatim_up=1
    info "Nominatim is up after $((attempt * 15))s"
  fi
  [ "$overpass_up" -eq 1 ] || if overpass_ready; then
    overpass_up=1
    info "Overpass is up after $((attempt * 15))s"
  fi

  if [ "$nominatim_up" -eq 1 ] && [ "$overpass_up" -eq 1 ]; then
    break
  fi
  if [ "$attempt" -eq 240 ]; then
    info "still importing after an hour — follow it with:"
    info "  docker compose logs -f nominatim overpass"
  fi
  sleep 15
done

# Stamp what each service actually imported.
#
# Neither can be asked which extract it holds, and both import on FIRST BOOT
# only — so without a stamp there is no way to tell a Nominatim serving the
# current extract from one serving last month's, and `pnpm geo:status` would
# have to shrug at the two artifacts most likely to be stale. Written only
# after the service answered, so a stamp never claims an import that failed.
MERGED_SHA=$(sha256sum "$MERGED" | cut -d' ' -f1)
[ "$nominatim_up" -eq 1 ] && printf '%s' "$MERGED_SHA" > "$OUT_DIR/.imported-nominatim"
[ "$overpass_up" -eq 1 ] && printf '%s' "$MERGED_SHA" > "$OUT_DIR/.imported-overpass"

# --- 6. the artifact manifest ---------------------------------------------

step "Writing the artifact manifest"
# Last, because it checksums the outputs of every step above. The epoch it
# derives prefixes every cached route, POI set and geocode, so this run's
# artifacts cannot be described by a stale manifest — and a rebuild with
# different bounds strands the previous run's cache entries instead of serving
# them. See DECISIONS.md D46.
pnpm -s tsx scripts/geo-manifest.ts write

# --- summary ---------------------------------------------------------------

step "Done in $(elapsed)"
printf '    %-38s %s\n' "artifact" "size"
printf '    %-38s %s\n' "--------" "----"
for file in $DOWNLOADS; do
  printf '    %-38s %s\n' "$CACHE_DIR/$file" "$(file_size "$CACHE_DIR/$file")"
done
while read -r slug _rest; do
  [ -n "${slug:-}" ] || continue
  printf '    %-38s %s\n' "$CACHE_DIR/$slug.osm.pbf" "$(file_size "$CACHE_DIR/$slug.osm.pbf")"
done <<< "$EXTRACTS"
printf '    %-38s %s\n' "$MERGED" "$(file_size "$MERGED")"

cat <<'SUMMARY'

Next:
  docker compose --profile geo up -d     # osrm-car, osrm-bike, nominatim, overpass
  pnpm cities:boundaries                 # city polygons, from the local Nominatim
  pnpm db:deploy && pnpm db:seed         # schema + three cities of listings
  pnpm geo:status                        # what is stale, and how to rebuild it
SUMMARY
