/**
 * Coverage: the three cities the product serves, as a first-class concept.
 *
 * Before correction 9 "we do not serve Mumbai" and "there is nothing in
 * Mumbai" were the same response — an empty list. That is the worst available
 * answer, because a house-hunter in an uncovered city concludes the product has
 * no listings rather than that it does not reach them yet. So every geo entry
 * point now resolves coverage first and the out-of-coverage case has its own
 * shape, its own message and its own next action.
 *
 * These are schemas only, and they live in the package **index** rather than in
 * `@machiya/shared/cities`: the browser reads the coverage set from
 * `GET /api/coverage` and must not import the city config, whose module graph
 * reaches `node:crypto`. That is also the point of the endpoint — adding a
 * fourth city widens the served set with no frontend change.
 */
import { z } from 'zod';
import { cityBboxSchema, coordinateSchema } from './schemas.js';

/**
 * A city boundary as GeoJSON.
 *
 * Loose about ring nesting on purpose: a Polygon is `ring[point[]]` and a
 * MultiPolygon is `polygon[ring[point[]]]`, and a schema that discriminated
 * between them here would have to be kept in step with `CityBoundary` in the
 * generated city boundaries for no gain — maplibre accepts either as-is.
 */
export const boundaryGeoJsonSchema = z.union([
  z.object({
    type: z.literal('Polygon'),
    coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
  }),
  z.object({
    type: z.literal('MultiPolygon'),
    coordinates: z.array(z.array(z.array(z.tuple([z.number(), z.number()])))),
  }),
]);

export type BoundaryGeoJson = z.infer<typeof boundaryGeoJsonSchema>;

export const coveredCitySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  state: z.string().min(1),
  centroid: coordinateSchema,
  /** The ADMINISTRATIVE box. Fitting the camera to one city uses this. */
  bbox: cityBboxSchema,
  /** The box the OSM artifacts were cut from — 9 km wider (D47). */
  paddedBbox: cityBboxSchema,
  /**
   * The administrative polygon, or null when `pnpm cities:boundaries` has
   * never run here. Null means city assignment inside coverage falls back to
   * nearest centroid, which is fine and logged — it does NOT mean the city is
   * uncovered, because coverage's outer bound is the padded box.
   */
  boundary: boundaryGeoJsonSchema.nullable(),
});

export type CoveredCity = z.infer<typeof coveredCitySchema>;

export const coverageSetSchema = z.object({
  cities: z.array(coveredCitySchema),
  /**
   * The bounding rectangle of every padded box. This is what the map's
   * `maxBounds` is set to, so panning to an uncovered city is never offered —
   * and because it is derived rather than written down, a fourth city widens
   * it with no frontend change.
   */
  maxBounds: cityBboxSchema,
  /**
   * The geo epoch the artifacts were built at. Present so a client can tell a
   * coverage set apart across a rebuild, and so `/api/coverage` can be cached
   * hard without stranding a widened set behind a browser cache.
   */
  epoch: z.string().min(1),
});

export type CoverageSet = z.infer<typeof coverageSetSchema>;

export const nearestCitySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  /** Straight-line metres from the requested point to the city centroid. */
  distanceMeters: z.number().nonnegative(),
});

export type NearestCity = z.infer<typeof nearestCitySchema>;

/**
 * The out-of-coverage answer, as every endpoint returns it.
 *
 * Self-contained deliberately: the message names the supported cities and the
 * nearest one, so the UI renders it from the response rather than joining it
 * against a second fetch that may not have landed yet.
 */
export const outOfCoverageSchema = z.object({
  /** So the UI can offer each as a one-tap action rather than as prose. */
  supportedCities: z.array(
    z.object({
      slug: z.string().min(1),
      name: z.string().min(1),
      centroid: coordinateSchema,
    }),
  ),
  /** Null only when no city is configured at all, which is a deploy fault. */
  nearest: nearestCitySchema.nullable(),
  /** The point that was asked about, echoed back for the capture form. */
  requested: coordinateSchema.nullable(),
  /** What the geocoder called that point, when it could name it. */
  requestedLabel: z.string().nullable(),
});

export type OutOfCoverage = z.infer<typeof outOfCoverageSchema>;

/** The error code every out-of-coverage rejection uses. One string, one meaning. */
export const OUT_OF_COVERAGE_CODE = 'out_of_coverage';

/**
 * One sentence, built from the response rather than hardcoded.
 *
 * "Machiya covers Patna, Bengaluru and Pune. Bengaluru is nearest, 840 km
 * away." Shared between the API's error message and the UI's designed state so
 * the two cannot drift, and honest about distance: rounded to kilometres past
 * 10 km, because "839.6 km" implies a precision that means nothing here.
 */
export function coverageMessage(coverage: OutOfCoverage): string {
  const names = coverage.supportedCities.map((city) => city.name);
  const list =
    names.length <= 1
      ? (names[0] ?? 'no cities yet')
      : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;

  const head = `Machiya covers ${list}.`;
  if (!coverage.nearest) return head;

  const km = coverage.nearest.distanceMeters / 1000;
  const distance = km < 10 ? `${km.toFixed(1)} km` : `${String(Math.round(km))} km`;

  return `${head} ${coverage.nearest.name} is nearest, ${distance} away.`;
}

/**
 * Whether a query is plausibly the name of a place.
 *
 * The gate on the autocomplete's coverage message. "mumbai" returning nothing
 * from both tiers almost certainly means we do not serve it; "asdfgh" or "%%%"
 * returning nothing means nothing, and answering it with "Machiya covers Patna,
 * Bengaluru and Pune" would be a non-sequitur that makes the product look like
 * it cannot read.
 *
 * Deliberately crude — a word of three or more letters, and no more than a
 * quarter of the query being digits. Anything cleverer would be a place-name
 * classifier, and the cost of a false positive here is one extra sentence in a
 * dropdown, not a wrong answer.
 */
export function looksLikePlaceName(query: string): boolean {
  const term = query.trim();
  if (term.length < 3) return false;

  // A letter followed by two more letters OR COMBINING MARKS.
  //
  // The marks are not decoration: `\p{L}{3,}` alone rejects "कोलकाता", because
  // Indic vowel signs are `\p{Mn}` rather than letters, so the longest run of
  // pure letters in it is two. A heuristic that silently excluded every
  // Devanagari and Kannada query from the coverage message would fail exactly
  // the users this product is for.
  if (!/\p{L}[\p{L}\p{M}]{2,}/u.test(term)) return false;

  const digits = (term.match(/\d/g) ?? []).length;
  return digits / term.length <= 0.25;
}

// --- "tell me when you cover Mumbai" ---------------------------------------

/**
 * The capture form behind the out-of-coverage state.
 *
 * This is the reason the state is worth building rather than just refusing:
 * `CoverageRequest` rows are the real signal for which city to add fourth,
 * which is worth more than a dead end.
 */
export const coverageRequestInputSchema = z.object({
  email: z.string().email().max(200),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** Whatever the geocoder called the point, when it could name it. */
  placeLabel: z.string().min(1).max(200).optional(),
});

export type CoverageRequestInput = z.infer<typeof coverageRequestInputSchema>;

export const coverageRequestResponseSchema = z.object({
  /** How many people have now asked about somewhere near this point. */
  requests: z.number().int().positive(),
});

export type CoverageRequestResponse = z.infer<typeof coverageRequestResponseSchema>;

/**
 * Coordinate precision a coverage request is stored at: 3 decimal places,
 * about 110 m.
 *
 * Requests are deduplicated per email per rounded point, so one person tapping
 * "tell me" three times on slightly different pins is one row rather than
 * three — otherwise the count that decides the fourth city is a count of taps.
 */
export const COVERAGE_REQUEST_PRECISION = 3;

export function roundCoverageRequestCoordinate(value: number): number {
  return Number(value.toFixed(COVERAGE_REQUEST_PRECISION));
}
