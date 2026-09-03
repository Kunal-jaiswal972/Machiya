/**
 * The seed cities. This is the ONLY place they are defined — bootstrap.sh reads
 * the bounding boxes from here (via the CLI at the bottom) and prisma/seed.ts
 * imports the same objects, so adding a fourth city is a single entry.
 *
 * Coordinates are WGS84. Each city carries TWO bounding boxes and they are not
 * interchangeable:
 *
 * - `bbox` is the administrative one written below. It answers "is this
 *   locality inside its city" and "are two cities ambiguous to assign between".
 * - `paddedBbox` is derived from it by `padBbox` and is what `osmium extract`
 *   cuts from. It is 9 km larger on every side, because a listing or an office
 *   near an edge needs road network and POIs on all sides of it, and a road
 *   route can legitimately leave the box and come back. See DECISIONS.md D47.
 *
 * The padded box is DERIVED, never written by hand: two boxes maintained
 * separately would drift, and the drift would look like a data bug in whichever
 * one you checked second.
 */

import { basename } from 'node:path';
import { BBOX_PAD_KM, padBbox } from '@machiya/shared/cities';

export type GeofabrikZone = 'eastern-zone' | 'southern-zone' | 'western-zone';

export interface Locality {
  name: string;
  lat: number;
  lng: number;
}

export interface CityConfig {
  slug: string;
  name: string;
  state: string;
  /** Which Geofabrik India zone extract contains this city. */
  zone: GeofabrikZone;
  centroid: { lat: number; lng: number };
  /** Administrative bounds. Validation and city assignment use this one. */
  bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number };
  /** `bbox` grown by BBOX_PAD_KM. Artifacts are cut from this one. Derived. */
  paddedBbox: { minLng: number; minLat: number; maxLng: number; maxLat: number };
  defaultFuelType: 'PETROL' | 'DIESEL' | 'CNG';
  /** Local bus fares, in whole rupees. No free API exposes these reliably. */
  transitFare: {
    currency: string;
    baseFare: number;
    perKm: number;
    minFare: number;
    notes: string;
  };
  /** Where seeded listings cluster, so the map does not look uniformly random. */
  localities: Locality[];
}

type CityConfigInput = Omit<CityConfig, 'paddedBbox'>;

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
    localities: [
      { name: 'Boring Road', lat: 25.6127, lng: 85.1145 },
      { name: 'Kankarbagh', lat: 25.59, lng: 85.156 },
      { name: 'Rajendra Nagar', lat: 25.6053, lng: 85.1567 },
      { name: 'Patliputra Colony', lat: 25.6229, lng: 85.1093 },
      { name: 'Sheikhpura', lat: 25.612, lng: 85.09 },
      { name: 'Ashok Rajpath', lat: 25.618, lng: 85.172 },
    ],
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
    localities: [
      { name: 'Koramangala', lat: 12.9352, lng: 77.6245 },
      { name: 'Indiranagar', lat: 12.9784, lng: 77.6408 },
      { name: 'Whitefield', lat: 12.9698, lng: 77.75 },
      { name: 'HSR Layout', lat: 12.9121, lng: 77.6446 },
      { name: 'Jayanagar', lat: 12.925, lng: 77.5938 },
      { name: 'Hebbal', lat: 13.0358, lng: 77.597 },
    ],
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
    localities: [
      { name: 'Kothrud', lat: 18.5074, lng: 73.8077 },
      { name: 'Baner', lat: 18.5642, lng: 73.7769 },
      { name: 'Viman Nagar', lat: 18.5679, lng: 73.9143 },
      { name: 'Kharadi', lat: 18.5515, lng: 73.947 },
      { name: 'Hinjewadi', lat: 18.5913, lng: 73.7389 },
      { name: 'Aundh', lat: 18.559, lng: 73.8074 },
    ],
  },
];

/**
 * The city list every consumer reads. `paddedBbox` is attached here, once, so
 * no caller can accidentally cut an artifact from the administrative box.
 */
export const CITIES: CityConfig[] = CITY_INPUTS.map((city) => ({
  ...city,
  paddedBbox: padBbox(city.bbox, BBOX_PAD_KM),
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
 * CLI used by scripts/bootstrap.sh, so the shell never hardcodes a coordinate.
 *
 *   tsx scripts/cities.ts zones    -> one zone name per line
 *   tsx scripts/cities.ts extracts -> "slug zone minLng minLat maxLng maxLat" per line,
 *                                     with the PADDED box: it is what osmium cuts
 *   tsx scripts/cities.ts bboxes   -> the same for the unpadded administrative box
 */
function main(command: string | undefined): void {
  switch (command) {
    case 'zones':
      console.log(ZONES.join('\n'));
      return;
    case 'extracts':
      // The PADDED box, deliberately: this is what bootstrap.sh cuts with.
      console.log(
        CITIES.map((city) =>
          [
            city.slug,
            city.zone,
            city.paddedBbox.minLng,
            city.paddedBbox.minLat,
            city.paddedBbox.maxLng,
            city.paddedBbox.maxLat,
          ].join(' '),
        ).join('\n'),
      );
      return;
    case 'bboxes':
      // The administrative box, for anything validating membership.
      console.log(
        CITIES.map((city) =>
          [
            city.slug,
            city.zone,
            city.bbox.minLng,
            city.bbox.minLat,
            city.bbox.maxLng,
            city.bbox.maxLat,
          ].join(' '),
        ).join('\n'),
      );
      return;
    case 'slugs':
      console.log(CITIES.map((city) => city.slug).join('\n'));
      return;
    default:
      console.error('Usage: tsx scripts/cities.ts <zones|extracts|bboxes|slugs>');
      process.exit(1);
  }
}

// Only act as a CLI when executed directly, never when imported by the seed.
if (process.argv[1] && basename(process.argv[1]) === 'cities.ts') {
  main(process.argv[2]);
}
