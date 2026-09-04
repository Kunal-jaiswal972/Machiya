/**
 * The city-configuration rules. `scripts/validate-cities.ts` is the CLI that
 * reports them and `pnpm cities:validate` runs it in CI.
 *
 * The brief claims a new city is a one-entry change. That was true of the code
 * and false of the data, and the failure mode is the nasty kind: a fourth city
 * that geocodes and routes to nowhere while every page looks healthy. This
 * script is what makes the claim checkable — it fails when
 *
 *   1. a city record is missing a field or has a nonsensical one,
 *   2. a fuel source has no slug for a configured city,
 *   3. a locality has no coordinates,
 *   4. a locality falls outside its city's **unpadded** bbox,
 *   5. two **padded** bboxes overlap enough to make city assignment ambiguous.
 *
 * Note which box each of the last two uses. Localities are validated against
 * the administrative box because that is what "in this city" means; overlap is
 * checked on the padded box because that is what is actually cut, and two
 * cities whose extracts overlap have a genuinely ambiguous strip between them.
 * Conflating the two would make one of the checks meaningless (D47).
 *
 * `Locality` is also a database table, and the seed prunes it against this
 * config (D39). These are two different jobs: the validator checks the source
 * of truth, the seed keeps the table honest about it.
 */
import { z } from 'zod';
import { bboxAreaSqKm, bboxIntersection, isInsideBbox } from './bbox.js';
import { CITIES, GEOFABRIK_ZONES, type CityConfig } from './config.js';
import { FUEL_SOURCE_IDS } from './fuel-sources.js';

/**
 * How much padded-bbox overlap is tolerated, in square kilometres.
 *
 * Not zero: two neighbouring cities 60 km apart have 9 km of padding each, and
 * a thin overlap between their extracts is harmless — a point in it is
 * assigned by `ST_Contains` against the boundaries, not by the box. What is
 * NOT harmless is an overlap large enough that the nearest-centroid fallback
 * has to arbitrate a meaningful area, because that fallback is a guess.
 */
const MAX_PADDED_OVERLAP_SQ_KM = 25;

const localitySchema = z.object({
  name: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const bboxSchema = z
  .object({
    minLng: z.number().min(-180).max(180),
    minLat: z.number().min(-90).max(90),
    maxLng: z.number().min(-180).max(180),
    maxLat: z.number().min(-90).max(90),
  })
  .refine((box) => box.minLng < box.maxLng && box.minLat < box.maxLat, {
    message: 'bbox is inverted or empty',
  });

const cityRecordSchema = z.object({
  slug: z
    .string()
    .min(2)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase kebab-case: it appears in URLs'),
  name: z.string().min(2),
  state: z.string().min(2),
  zone: z.enum(GEOFABRIK_ZONES),
  centroid: z.object({ lat: z.number(), lng: z.number() }),
  bbox: bboxSchema,
  paddedBbox: bboxSchema,
  defaultFuelType: z.enum(['PETROL', 'DIESEL', 'CNG']),
  transitFare: z.object({
    currency: z.string().min(1),
    baseFare: z.number().nonnegative(),
    perKm: z.number().nonnegative(),
    minFare: z.number().nonnegative(),
    notes: z.string().optional(),
  }),
  // A city with no localities would pass every other check and then seed no
  // listings and answer no autocomplete, which is the "looks healthy" failure
  // this script exists for.
  localities: z.array(localitySchema).min(3),
  fuelSlugs: z.record(z.string(), z.string().min(1)),
});

export interface ValidationIssue {
  city?: string;
  rule: string;
  message: string;
  severity: 'error' | 'warning';
}

export function validateCities(cities: readonly CityConfig[] = CITIES): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (rule: string, message: string, city?: string): void => {
    issues.push({ ...(city ? { city } : {}), rule, message, severity: 'error' });
  };
  const warn = (rule: string, message: string, city?: string): void => {
    issues.push({ ...(city ? { city } : {}), rule, message, severity: 'warning' });
  };

  if (cities.length === 0) {
    error('non-empty', 'no cities are configured');
    return issues;
  }

  const seen = new Set<string>();

  for (const city of cities) {
    const parsed = cityRecordSchema.safeParse(city);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        error('record', `${issue.path.join('.') || '(root)'}: ${issue.message}`, city.slug);
      }
    }

    if (seen.has(city.slug)) {
      error('unique-slug', 'duplicate slug', city.slug);
    }
    seen.add(city.slug);

    // 2. Every source must know what this city is called in its own URLs.
    for (const sourceId of FUEL_SOURCE_IDS) {
      const slug = city.fuelSlugs[sourceId];
      if (!slug) {
        error(
          'fuel-slug',
          `no slug for fuel source "${sourceId}" — that source would silently return nothing for this city while the others covered for it`,
          city.slug,
        );
      }
    }
    for (const key of Object.keys(city.fuelSlugs)) {
      if (!FUEL_SOURCE_IDS.includes(key as (typeof FUEL_SOURCE_IDS)[number])) {
        warn('fuel-slug', `slug for unknown fuel source "${key}"`, city.slug);
      }
    }

    // 3 and 4. Localities: coordinates, and inside the administrative box.
    const localitySlugs = new Set<string>();
    for (const locality of city.localities) {
      if (!Number.isFinite(locality.lat) || !Number.isFinite(locality.lng)) {
        error('locality-coordinates', `"${locality.name}" has no usable coordinates`, city.slug);
        continue;
      }
      if (localitySlugs.has(locality.name.toLowerCase())) {
        error('locality-unique', `"${locality.name}" is listed twice`, city.slug);
      }
      localitySlugs.add(locality.name.toLowerCase());

      if (!isInsideBbox(locality, city.bbox)) {
        error(
          'locality-inside-city',
          `"${locality.name}" (${String(locality.lat)}, ${String(locality.lng)}) is outside the city bbox — either the coordinates are wrong or the bbox is too tight`,
          city.slug,
        );
      }
    }

    if (!isInsideBbox(city.centroid, city.bbox)) {
      error('centroid-inside-city', 'the centroid is outside the city bbox', city.slug);
    }

    // The boundary is generated, so a missing one is a warning: the app still
    // works, it just falls back to nearest-centroid assignment (D50).
    if (!city.boundary) {
      warn(
        'boundary',
        'no boundary polygon — city assignment will fall back to nearest centroid. Run `pnpm cities:boundaries` with the geo profile up',
        city.slug,
      );
    }
  }

  // 5. Ambiguous city assignment.
  for (let i = 0; i < cities.length; i += 1) {
    for (let j = i + 1; j < cities.length; j += 1) {
      const a = cities[i];
      const b = cities[j];
      if (!a || !b) continue;

      const overlap = bboxIntersection(a.paddedBbox, b.paddedBbox);
      if (!overlap) continue;

      const area = bboxAreaSqKm(overlap);
      const detail = `${a.slug} and ${b.slug} padded extracts overlap by ${area.toFixed(1)} km²`;

      if (area > MAX_PADDED_OVERLAP_SQ_KM) {
        error(
          'padded-overlap',
          `${detail} — larger than the ${String(MAX_PADDED_OVERLAP_SQ_KM)} km² tolerance, so a listing in the overlap cannot be assigned to a city without guessing`,
        );
      } else {
        warn('padded-overlap', detail);
      }
    }
  }

  return issues;
}
