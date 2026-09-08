/**
 * The city configuration. **Adding a city is one entry in `CITY_INPUTS`.**
 *
 * That claim used to be true of the code and false of the data: fuel scraper
 * slugs, transit fares, localities and every geo artifact were all per-city and
 * lived somewhere else. So this record now holds everything one city needs —
 * slug, display name, state, Geofabrik zone, centroid, both bounding boxes,
 * boundary polygon, localities with coordinates, transit fares, and a per-source
 * fuel slug map. Nothing city-specific may be hardcoded anywhere else, and
 * `scripts/validate-cities.ts` fails CI when a field is missing. See
 * DECISIONS.md D49, and `docs/adding-a-city.md` for the ordered checklist.
 *
 * This lives in `@machiya/shared/cities` — a node-only subpath, because the
 * module graph reaches `node:crypto` — and is read by the API, the seed, the
 * bootstrap scripts and the validator. `scripts/cities.ts` is a thin CLI over
 * it, kept because `bootstrap.sh` shells out to it.
 *
 * Coordinates are WGS84. Boundary polygons are NOT hand-written: they are
 * derived from the local Nominatim by `pnpm cities:boundaries`, which writes
 * `boundaries.generated.ts`.
 */
import type { FuelType } from '../enums.js';
import type { CityBbox, Coordinate, TransitFareConfig } from '../geo/schemas.js';
import { BBOX_PAD_KM, padBbox } from './bbox.js';
import { CITY_BOUNDARIES, type CityBoundary } from './boundaries.generated.js';
import type { FuelSourceId } from './fuel-sources.js';

/**
 * Geofabrik publishes India by **zone**, not by state — the per-state URLs the
 * brief assumed return an HTML error page, which fails much later as a corrupt
 * download (D27). All six zones are listed so a fourth city does not need this
 * union widened as well as a record added.
 */
export const GEOFABRIK_ZONES = [
  'central-zone',
  'eastern-zone',
  'north-eastern-zone',
  'northern-zone',
  'southern-zone',
  'western-zone',
] as const;

export type GeofabrikZone = (typeof GEOFABRIK_ZONES)[number];

export interface Locality {
  name: string;
  lat: number;
  lng: number;
}

export interface CityConfig {
  slug: string;
  /** Display name, as shown in the UI. */
  name: string;
  state: string;
  /** Which Geofabrik India zone extract contains this city. */
  zone: GeofabrikZone;
  centroid: Coordinate;
  /** Administrative bounds. Locality validation and city overlap use this. */
  bbox: CityBbox;
  /** `bbox` grown by BBOX_PAD_KM — what artifacts are cut from. Derived (D47). */
  paddedBbox: CityBbox;
  /**
   * The admin boundary, for assigning a listing to a city by containment
   * rather than by nearest centroid (D50). Null until
   * `pnpm cities:boundaries` has been run against a local Nominatim.
   */
  boundary: CityBoundary | null;
  defaultFuelType: FuelType;
  /** Local bus fares, in whole rupees. No free API exposes these reliably. */
  transitFare: TransitFareConfig;
  /**
   * When somebody last checked this city's fares against the operator, as
   * YYYY-MM-DD. `cities:validate` warns once it is older than
   * `TRANSIT_FARE_STALE_AFTER_DAYS`. See DECISIONS.md D73.
   */
  transitFareReviewedOn: string;
  /** Where seeded listings cluster, so the map does not look uniformly random. */
  localities: Locality[];
  /**
   * What each fuel-price source calls this city in its own URLs. Every source
   * in `FUEL_SOURCE_IDS` must have an entry — the validator enforces it —
   * because a missing slug is a scraper that silently returns nothing for one
   * city while the others cover for it.
   */
  fuelSlugs: Record<FuelSourceId, string>;
}

type CityConfigInput = Omit<CityConfig, 'paddedBbox' | 'boundary'>;

const CITY_INPUTS: CityConfigInput[] = [
  {
    slug: 'patna',
    name: 'Patna',
    state: 'Bihar',
    zone: 'eastern-zone',
    centroid: { lat: 25.5941, lng: 85.1376 },
    bbox: { minLng: 84.95, minLat: 25.5, maxLng: 85.3, maxLat: 25.68 },
    defaultFuelType: 'PETROL',
    transitFare: {
      currency: 'INR',
      baseFare: 10,
      perKm: 1.5,
      minFare: 10,
      notes: 'Patna city bus (BSRTC), approximate slab fares',
    },
    transitFareReviewedOn: '2026-09-05',
    localities: [
      { name: 'Boring Road', lat: 25.6127, lng: 85.1145 },
      { name: 'Kankarbagh', lat: 25.59, lng: 85.156 },
      { name: 'Rajendra Nagar', lat: 25.6053, lng: 85.1567 },
      { name: 'Patliputra Colony', lat: 25.6229, lng: 85.1093 },
      { name: 'Sheikhpura', lat: 25.612, lng: 85.09 },
      { name: 'Ashok Rajpath', lat: 25.618, lng: 85.172 },
    ],
    fuelSlugs: {
      goodreturns: 'patna',
      bankbazaar: 'patna',
      petrolpriceindia: 'patna',
    },
  },
  {
    slug: 'bengaluru',
    name: 'Bengaluru',
    state: 'Karnataka',
    zone: 'southern-zone',
    centroid: { lat: 12.9716, lng: 77.5946 },
    bbox: { minLng: 77.45, minLat: 12.82, maxLng: 77.78, maxLat: 13.14 },
    defaultFuelType: 'PETROL',
    transitFare: {
      currency: 'INR',
      baseFare: 6,
      perKm: 1.2,
      minFare: 6,
      notes: 'BMTC ordinary service, approximate slab fares',
    },
    transitFareReviewedOn: '2026-09-05',
    localities: [
      { name: 'Koramangala', lat: 12.9352, lng: 77.6245 },
      { name: 'Indiranagar', lat: 12.9784, lng: 77.6408 },
      { name: 'Whitefield', lat: 12.9698, lng: 77.75 },
      { name: 'HSR Layout', lat: 12.9121, lng: 77.6446 },
      { name: 'Jayanagar', lat: 12.925, lng: 77.5938 },
      { name: 'Hebbal', lat: 13.0358, lng: 77.597 },
    ],
    // The reason this map exists rather than reusing `slug`: **all three**
    // sources index the city under its former name. Verified per source, not
    // assumed — `.../petrol-price-in-bengaluru.html` is a 404 on goodreturns
    // while `...-bangalore.html` returns the city. A single `slug` would have
    // made Bengaluru the quiet city the validator exists to catch.
    fuelSlugs: {
      goodreturns: 'bangalore',
      bankbazaar: 'bangalore',
      petrolpriceindia: 'bangalore',
    },
  },
  {
    slug: 'pune',
    name: 'Pune',
    state: 'Maharashtra',
    zone: 'western-zone',
    centroid: { lat: 18.5204, lng: 73.8567 },
    bbox: { minLng: 73.72, minLat: 18.4, maxLng: 74.0, maxLat: 18.65 },
    defaultFuelType: 'PETROL',
    transitFare: {
      currency: 'INR',
      baseFare: 5,
      perKm: 1.1,
      minFare: 5,
      notes: 'PMPML ordinary service, approximate slab fares',
    },
    transitFareReviewedOn: '2026-09-05',
    localities: [
      { name: 'Kothrud', lat: 18.5074, lng: 73.8077 },
      { name: 'Baner', lat: 18.5642, lng: 73.7769 },
      { name: 'Viman Nagar', lat: 18.5679, lng: 73.9143 },
      { name: 'Kharadi', lat: 18.5515, lng: 73.947 },
      { name: 'Hinjewadi', lat: 18.5913, lng: 73.7389 },
      { name: 'Aundh', lat: 18.559, lng: 73.8074 },
    ],
    fuelSlugs: {
      goodreturns: 'pune',
      bankbazaar: 'pune',
      petrolpriceindia: 'pune',
    },
  },
];

/**
 * The city list every consumer reads.
 *
 * Two fields are attached here rather than written by hand, so they cannot
 * drift from their sources: `paddedBbox` (derived from `bbox`, D47) and
 * `boundary` (generated from Nominatim, D50).
 */
export const CITIES: CityConfig[] = CITY_INPUTS.map((city) => ({
  ...city,
  paddedBbox: padBbox(city.bbox, BBOX_PAD_KM),
  boundary: CITY_BOUNDARIES[city.slug] ?? null,
}));

export const ZONES: GeofabrikZone[] = [...new Set(CITIES.map((city) => city.zone))];

export function cityBySlug(slug: string): CityConfig {
  const city = CITIES.find((candidate) => candidate.slug === slug);
  if (!city) {
    throw new Error(`Unknown city slug: ${slug}. Known: ${CITIES.map((c) => c.slug).join(', ')}`);
  }
  return city;
}

/**
 * Beyond this many distinct Geofabrik zones, downloading the whole country is
 * smaller than downloading the zones one at a time.
 *
 * The zones covering the seed cities are 236 MB (eastern), 533 MB (southern)
 * and 210 MB (western) — about 1 GB for three. `india-latest.osm.pbf` is
 * roughly 1.4 GB, so a fourth zone is where the sum crosses it. Past that
 * point the binding constraint stops being download size and becomes OSRM
 * graph RAM: see docs/adding-a-city.md.
 */
export const WHOLE_COUNTRY_ZONE_THRESHOLD = 4;

export type DownloadStrategy = 'zones' | 'country';

export interface DownloadPlan {
  strategy: DownloadStrategy;
  /** File names to fetch from the Geofabrik India directory. */
  files: string[];
  /** Logged by bootstrap, so the choice is never silent. */
  reason: string;
}

/**
 * Which extracts to download for a given city list.
 *
 * Chosen automatically rather than configured, because the arithmetic is not a
 * preference — but logged with its reason, because a silent switch from three
 * 200 MB files to one 1.4 GB file is the kind of thing that reads as a bug in
 * a slow-network bug report.
 */
/**
 * Which downloaded file a city in `zone` is cut from under the current plan.
 *
 * Below the whole-country threshold that is the zone's own extract; at or above
 * it, `india-latest.osm.pbf` for every city. Lives here rather than in
 * bootstrap.sh so the shell does not have to know the two strategies apart, and
 * so `geo-status` and the cut stamps agree on the answer (D85).
 */
export function sourceFileFor(zone: string, cities: readonly CityConfig[] = CITIES): string {
  return planDownloads(cities).strategy === 'country'
    ? 'india-latest.osm.pbf'
    : `${zone}-latest.osm.pbf`;
}

export function planDownloads(cities: readonly CityConfig[] = CITIES): DownloadPlan {
  const zones = [...new Set(cities.map((city) => city.zone))].sort();

  if (zones.length >= WHOLE_COUNTRY_ZONE_THRESHOLD) {
    return {
      strategy: 'country',
      files: ['india-latest.osm.pbf'],
      reason: `${String(zones.length)} zones (${zones.join(', ')}) sum to more than india-latest.osm.pbf`,
    };
  }

  return {
    strategy: 'zones',
    files: zones.map((zone) => `${zone}-latest.osm.pbf`),
    reason: `${String(zones.length)} zone(s) (${zones.join(', ')}), below the ${String(
      WHOLE_COUNTRY_ZONE_THRESHOLD,
    )}-zone whole-country threshold`,
  };
}
