/**
 * The three geo provider interfaces every feature codes against.
 *
 * Nothing in this file knows about Nominatim, OSRM or Overpass. That is the
 * point: the concrete clients live in `apps/api/src/geo/`, so swapping one out
 * (self-hosted to hosted, Overpass to a vendor POI API) touches one adapter and
 * no feature code. The result shapes are Zod schemas rather than bare types
 * because they cross a network boundary in both directions — the API parses what
 * a provider returned, and the browser parses what the API returned.
 *
 * Every provider is allowed to degrade. A geocoder that is still importing, a
 * routing graph that has not been built, an Overpass mirror answering 429 — all
 * of those are ordinary states, so the interfaces return "no answer" or a
 * `degraded` flag rather than throwing. A rental search must not 500 because a
 * free tier said no.
 */
import { z } from 'zod';
import { matchPrecisionSchema } from './address.js';
import { outOfCoverageSchema } from './coverage.js';
import { cityBboxSchema, type Coordinate } from './schemas.js';

// --- geocoding --------------------------------------------------------------

/**
 * What a suggestion is. Kept coarse on purpose: the UI groups by it and the
 * ranking weights it, and a finer taxonomy would just be Nominatim's `class`
 * leaking into the client.
 */
export const geocodeResultKindSchema = z.enum(['city', 'locality', 'listing', 'address', 'poi']);

export type GeocodeResultKind = z.infer<typeof geocodeResultKindSchema>;

/** Which tier answered. Shown per row, so a user can tell local from remote. */
export const geocodeSourceSchema = z.enum(['local', 'nominatim']);

export type GeocodeSource = z.infer<typeof geocodeSourceSchema>;

export const geocodeResultSchema = z.object({
  /** Stable within a source, so React keys and de-duplication both work. */
  id: z.string().min(1),
  /** The bold line: "Koramangala", "Ashoka Grand, Boring Road". */
  label: z.string().min(1),
  /** The quiet line under it: "Bengaluru, Karnataka". Absent when redundant. */
  context: z.string().optional(),
  lat: z.number(),
  lng: z.number(),
  kind: geocodeResultKindSchema,
  source: geocodeSourceSchema,
  /**
   * How precise this answer is relative to the query that produced it, so the
   * UI can say what it actually did — "Showing Rajendra Nagar, drag the pin to
   * your exact spot" rather than presenting a neighbourhood as an address.
   * See `matchPrecisionSchema`.
   */
  matchPrecision: matchPrecisionSchema,
  /** 0-1, comparable ACROSS sources — that is what lets the tiers merge. */
  score: z.number().min(0).max(1),
  /** Present for cities, so selecting one can fit the map to it. */
  bbox: cityBboxSchema.optional(),
  /** Set when the suggestion is one of our own published listings. */
  listingSlug: z.string().min(1).optional(),
  citySlug: z.string().min(1).optional(),
});

export type GeocodeResult = z.infer<typeof geocodeResultSchema>;

export interface GeocodeSearchOptions {
  /** Bias and, for the local tier, restrict results to one city. */
  citySlug?: string;
  limit?: number;
  /** Aborts an in-flight upstream request when the user keeps typing. */
  signal?: AbortSignal;
}

/**
 * What a geocoder search returned, and whether it was able to answer at all.
 *
 * The two are different and the code used to conflate them: `results.length ===
 * 0` was read as "the provider is degraded", so Nominatim correctly answering
 * "there is no Mumbai in this extract" looked identical to Nominatim being
 * down. One of those is a fact about the data and the other is a fault, they
 * want opposite messages, and correction 9 needs to tell them apart to decide
 * between the coverage message and the degraded one.
 */
export interface GeocodeSearchOutcome {
  results: GeocodeResult[];
  /**
   * True when the provider could not answer — down, still importing, rate
   * limited, timed out, or the request was aborted. **False** when it answered
   * with an empty list, which is a real answer.
   */
  refused: boolean;
}

export interface GeocodeProvider {
  /** Used in logs and in the `source` field of every result it returns. */
  readonly name: GeocodeSource;
  search(query: string, options?: GeocodeSearchOptions): Promise<GeocodeSearchOutcome>;
  /** Null rather than throwing when the point is over water or unmapped. */
  reverse(
    coordinate: Coordinate,
    options?: { signal?: AbortSignal },
  ): Promise<GeocodeResult | null>;
}

// --- routing ----------------------------------------------------------------

export const routeProfileSchema = z.enum(['car', 'bike']);

export type RouteProfile = z.infer<typeof routeProfileSchema>;

export const routeGeometrySchema = z.object({
  type: z.literal('LineString'),
  /** [lng, lat] pairs, GeoJSON order. */
  coordinates: z.array(z.tuple([z.number(), z.number()])),
});

export const routeResultSchema = z.object({
  profile: routeProfileSchema,
  /** Real road distance. Never a straight line — that is `ST_Distance`'s job. */
  distanceMeters: z.number().nonnegative(),
  durationSeconds: z.number().nonnegative(),
  geometry: routeGeometrySchema.nullable(),
  /**
   * True when this came from a fallback rather than the configured graph — a
   * cached copy served while the router is down, or the public OSRM demo server.
   * The UI labels it rather than presenting an estimate as measured fact.
   */
  degraded: z.boolean().default(false),
});

export type RouteResult = z.infer<typeof routeResultSchema>;

/**
 * One row of a distance matrix: one origin to many destinations.
 *
 * `null` for a destination the graph cannot reach from the origin, which is a
 * real answer and not an error — an address on an island, or a coordinate that
 * snapped to a disconnected fragment. The caller substitutes a labelled
 * estimate rather than dropping the destination, because a listing that
 * vanishes from results for an invisible reason is worse than one with an
 * approximate commute.
 */
export const routeMatrixSchema = z.object({
  profile: routeProfileSchema,
  /** Metres per destination, in the order they were asked for. */
  distances: z.array(z.number().nonnegative().nullable()),
  /** Seconds per destination, same order. */
  durations: z.array(z.number().nonnegative().nullable()),
});

export type RouteMatrix = z.infer<typeof routeMatrixSchema>;

export interface RoutingProvider {
  readonly name: string;
  /** Null when no route exists between the points on that graph. */
  route(input: {
    from: Coordinate;
    to: Coordinate;
    profile: RouteProfile;
    signal?: AbortSignal;
  }): Promise<RouteResult | null>;
  /**
   * Road distance from ONE origin to many destinations, in one request.
   *
   * This exists so that sorting by total monthly cost can happen inside the
   * search query. That sort needs the real road distance to every candidate in
   * the radius, and N separate `route` calls would be hundreds of round trips
   * per search — which is why the sort would otherwise end up client-side over
   * a single page, ranking 24 arbitrary listings.
   *
   * Null when the matrix could not be obtained at all. A partial answer comes
   * back as nulls inside the arrays.
   */
  table(input: {
    from: Coordinate;
    to: readonly Coordinate[];
    profile: RouteProfile;
    signal?: AbortSignal;
  }): Promise<RouteMatrix | null>;
}

// --- POIs -------------------------------------------------------------------

/**
 * The seven categories the detail sidebar shows. Fixed rather than open: they
 * are one batched Overpass query, a legend, and a set of icon layers, and each
 * of those has to know the full set up front.
 */
export const poiCategorySchema = z.enum([
  'hospital',
  'police',
  'school',
  'pharmacy',
  'atm',
  'supermarket',
  'transit',
]);

export type PoiCategory = z.infer<typeof poiCategorySchema>;

export const POI_CATEGORIES = poiCategorySchema.options;

export const poiSchema = z.object({
  id: z.string().min(1),
  category: poiCategorySchema,
  /** Unnamed features are common in OSM; the UI falls back to the category. */
  name: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  /** Straight-line metres from the subject listing. */
  distanceMeters: z.number().nonnegative(),
});

export type Poi = z.infer<typeof poiSchema>;

export const poiLookupResultSchema = z.object({
  pois: z.array(poiSchema),
  /**
   * True when the answer is a stale cache entry or an empty set served because
   * the upstream refused — a 429 from a free Overpass mirror must degrade the
   * panel, not fail the page. The UI says "couldn't refresh" instead of "none
   * nearby", because those mean opposite things to someone choosing a home.
   */
  degraded: z.boolean().default(false),
  fetchedAt: z.string(),
});

export type PoiLookupResult = z.infer<typeof poiLookupResultSchema>;

export interface PoiProvider {
  readonly name: string;
  nearby(input: {
    center: Coordinate;
    radiusMeters: number;
    categories?: readonly PoiCategory[];
    signal?: AbortSignal;
  }): Promise<PoiLookupResult>;
}

// --- the autocomplete envelope ---------------------------------------------

/**
 * Which of the three autocomplete outcomes this is.
 *
 * One enum rather than a pair of booleans, because the states are mutually
 * exclusive and a boolean pair lets the UI show two messages at once — or the
 * wrong one. Correction 9 exists because two of these used to be the same
 * value:
 *
 *  - `ok` — the list is the answer, empty or not. An empty `ok` inside a
 *    covered city means the query genuinely matched nothing there.
 *  - `degraded` — tier 2 was needed and **could not answer**: importing, rate
 *    limited, down. The local rows still stand and the fix is upstream.
 *  - `out_of_coverage` — both tiers answered, both empty, and the query reads
 *    like a place name. Almost always a city we do not serve, and the fix is
 *    to say which cities we do.
 */
export const placeSuggestionStateSchema = z.enum(['ok', 'degraded', 'out_of_coverage']);

export type PlaceSuggestionState = z.infer<typeof placeSuggestionStateSchema>;

/**
 * One endpoint, one ranked list, a `source` per row. The client never knows
 * which tier answered, only that some rows came from our own data — see D39.
 */
export const placeSuggestionsSchema = z.object({
  suggestions: z.array(geocodeResultSchema),
  /** Which tiers contributed, for the dev-only debug line and for tests. */
  sources: z.array(geocodeSourceSchema),
  state: placeSuggestionStateSchema,
  /**
   * Present only when `state` is `out_of_coverage`, so the dropdown can name
   * the served cities without a second fetch. Declared here rather than as a
   * separate response shape because the suggestions array is still meaningful:
   * a query can match one of our own listings and still be out of coverage.
   */
  coverage: outOfCoverageSchema.optional(),
});

export type PlaceSuggestions = z.infer<typeof placeSuggestionsSchema>;

/**
 * The reverse-geocode envelope.
 *
 * `place: null` with no `coverage` means "there is no address at that point",
 * which is a legitimate answer about a legitimate coordinate — a new campus on
 * the edge of town is exactly that, and the UI shows the coordinates. `place:
 * null` WITH `coverage` means the point is somewhere the product does not
 * reach, which wants the coverage state instead. Conflating the two is what
 * made a Mumbai pin look like an unmapped field.
 */
export const reversePlaceResponseSchema = z.object({
  place: geocodeResultSchema.nullable(),
  coverage: outOfCoverageSchema.optional(),
});

export type ReversePlaceResponse = z.infer<typeof reversePlaceResponseSchema>;

export const placeSearchQuerySchema = z.object({
  q: z.string().min(1).max(120),
  citySlug: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

export type PlaceSearchQuery = z.infer<typeof placeSearchQuerySchema>;

/** Below this, only the local tier runs — see D39 for why. */
export const AUTOCOMPLETE_MIN_REMOTE_CHARS = 3;

/**
 * Tier 2 runs only when tier 1 returned fewer than this many CONFIDENT rows.
 *
 * Confident, not merely present — see `AUTOCOMPLETE_CONFIDENT_SCORE`. Counting
 * rows alone let eight weak matches suppress the upstream tier that had the
 * right answer.
 */
export const AUTOCOMPLETE_LOCAL_SUFFICIENT_COUNT = 5;

/**
 * The similarity a LISTING row needs before it counts towards tier 1 being
 * sufficient.
 *
 * Found live rather than reasoned about: "Flat 3, Bailey Road, Patna" returned
 * eight listing rows at 0.117 each — every flat in Boring Road, because
 * "Boring Road" and "Bailey Road" share trigrams — which cleared the count of
 * five, suppressed tier 2, and so never asked Nominatim, which knows Bailey
 * Road perfectly well. Eight weak matches are not an answer to a place query.
 *
 * Place rows (a city or a locality) count at any score: they are the answer
 * this box exists to give, and a weak trigram hit on a locality name is still a
 * locality. Only listing rows have to clear the bar.
 */
export const AUTOCOMPLETE_CONFIDENT_SCORE = 0.4;

/** Client-side debounce before tier 2 can be reached, in milliseconds. */
export const AUTOCOMPLETE_DEBOUNCE_MS = 250;
