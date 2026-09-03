#!/usr/bin/env bash
#
# One-time (and re-runnable) setup of the local geo stack for the three seed
# cities defined in scripts/cities.ts.
#
#   1. download the Geofabrik India zone extracts that contain those cities
#   2. cut each city out by bounding box with osmium
#   3. merge the cuts into one small .osm.pbf
#   4. build the OSRM car and bicycle graphs from it
#   5. import it into a self-hosted Nominatim for geocoding
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

ZONES=$(pnpm -s tsx scripts/cities.ts zones)
EXTRACTS=$(pnpm -s tsx scripts/cities.ts extracts)
info "cities: $(pnpm -s tsx scripts/cities.ts slugs | tr '\n' ' ')"

# --- 1. download the zone extracts ----------------------------------------

step "Downloading Geofabrik zone extracts"
for zone in $ZONES; do
  target="$CACHE_DIR/$zone-latest.osm.pbf"

  if [ -s "$target" ]; then
    skip "$zone-latest.osm.pbf already cached ($(file_size "$target"))"
    continue
  fi

  info "fetching $zone (this is the slow part; it is cached afterwards)"
  # -C - resumes a partial download; write to .part so an interrupted run never
  # leaves a truncated file that later steps would treat as complete.
  # -# is the compact progress bar: the default meter writes a line per update,
  # which turns a piped log into thousands of lines.
  curl -fL -# --retry 3 --retry-delay 2 -C - \
    -o "$target.part" "$GEOFABRIK_BASE/$zone-latest.osm.pbf"
  mv "$target.part" "$target"
  info "$zone: $(file_size "$target")"
done

# --- 2. cut each city out by bounding box ---------------------------------

step "Extracting cities by bounding box"
CITY_FILES=()
while read -r slug zone min_lng min_lat max_lng max_lat; do
  [ -n "${slug:-}" ] || continue
  target="$CACHE_DIR/$slug.osm.pbf"
  CITY_FILES+=("/cache/$slug.osm.pbf")

  if [ -s "$target" ]; then
    skip "$slug.osm.pbf already cut ($(file_size "$target"))"
    continue
  fi

  info "cutting $slug from $zone"
  osmium extract \
    --bbox "$min_lng,$min_lat,$max_lng,$max_lat" \
    --set-bounds \
    --overwrite \
    -o "/cache/$slug.osm.pbf" \
    "/cache/$zone-latest.osm.pbf"
  info "$slug: $(file_size "$target")"
done <<< "$EXTRACTS"

# --- 3. merge into one file -----------------------------------------------

step "Merging city extracts"
if [ -s "$MERGED" ]; then
  skip "merged.osm.pbf already built ($(file_size "$MERGED"))"
else
  osmium merge --overwrite -o /out/merged.osm.pbf "${CITY_FILES[@]}"
  info "merged.osm.pbf: $(file_size "$MERGED")"
fi

[ -s "$MERGED" ] || die "merge produced no output"

# --- 4. OSRM graphs --------------------------------------------------------

step "Building OSRM graphs (car + bicycle)"
# The build itself lives in the osrm-init compose service, so the pipeline is
# defined once and `docker compose --profile geo up` can rebuild it too. That
# container skips any profile whose graph is already present.
docker compose --profile geo run --rm --no-deps osrm-init

# --- 5. Nominatim import --------------------------------------------------

step "Importing into Nominatim"
# mediagis/nominatim imports PBF_PATH on first boot into its own volume, then
# serves. So there is no separate import command: start it and wait. A second
# run finds the volume populated and comes straight up.
docker compose --profile geo up -d nominatim

info "waiting for Nominatim to answer (a first import of three cities takes a while)"
NOMINATIM_PORT_LOCAL="${NOMINATIM_PORT:-7070}"
for attempt in $(seq 1 240); do
  if curl -fsS "http://127.0.0.1:$NOMINATIM_PORT_LOCAL/status" >/dev/null 2>&1; then
    info "Nominatim is up after $((attempt * 15))s"
    break
  fi
  if [ "$attempt" -eq 240 ]; then
    info "still importing after an hour — follow it with: docker compose logs -f nominatim"
  fi
  sleep 15
done

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
for zone in $ZONES; do
  printf '    %-38s %s\n' "$CACHE_DIR/$zone-latest.osm.pbf" "$(file_size "$CACHE_DIR/$zone-latest.osm.pbf")"
done
while read -r slug _rest; do
  [ -n "${slug:-}" ] || continue
  printf '    %-38s %s\n' "$CACHE_DIR/$slug.osm.pbf" "$(file_size "$CACHE_DIR/$slug.osm.pbf")"
done <<< "$EXTRACTS"
printf '    %-38s %s\n' "$MERGED" "$(file_size "$MERGED")"

cat <<'SUMMARY'

Next:
  docker compose --profile geo up -d     # osrm-car, osrm-bike, nominatim
  pnpm db:deploy && pnpm db:seed         # schema + three cities of listings
SUMMARY
