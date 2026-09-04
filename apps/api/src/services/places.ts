import { searchPlacesLocally, type LocalPlaceRow } from '@machiya/db';
import {
  AUTOCOMPLETE_LOCAL_SUFFICIENT_COUNT,
  AUTOCOMPLETE_MIN_REMOTE_CHARS,
  OUT_OF_COVERAGE_CODE,
  cityBboxSchema,
  looksLikePlaceName,
  type Coordinate,
  type GeocodeResult,
  type GeocodeSource,
  type PlaceSearchQuery,
  type PlaceSuggestions,
  type ReversePlaceResponse,
} from '@machiya/shared';
import { resolveGeocodeProvider } from '../geo/nominatim.js';
import { checkCoverage, outOfCoverageFor, outOfCoverageForQuery } from './coverage.js';

/**
 * The two-tier place autocomplete behind one endpoint.
 *
 * Tier 1 is `pg_trgm` over our own City, Locality and published Listing rows —
 * local, indexed, single-digit milliseconds, and relevant to the three cities
 * this product actually serves. Tier 2 is Nominatim, and it only runs when tier
 * 1 came up short. See DECISIONS.md D39.
 *
 * The client sees one ranked list with a `source` per row and never has to know
 * which tier answered.
 */

function toGeocodeResult(row: LocalPlaceRow): GeocodeResult {
  const bbox = cityBboxSchema.safeParse(row.bbox);

  return {
    id: row.id,
    label: row.label,
    ...(row.context ? { context: row.context } : {}),
    lat: row.lat,
    lng: row.lng,
    kind: row.kind,
    source: 'local',
    score: row.score,
    ...(bbox.success ? { bbox: bbox.data } : {}),
    ...(row.listingSlug ? { listingSlug: row.listingSlug } : {}),
    ...(row.citySlug ? { citySlug: row.citySlug } : {}),
  };
}

/**
 * Collapses the same place arriving from both tiers.
 *
 * Nominatim knows "Koramangala" and so do we, and showing it twice makes the
 * merge look broken. Identity is the normalised label plus a coordinate rounded
 * to roughly 100 m — close enough that two sources describing one neighbourhood
 * collide, far enough apart that two genuinely different Main Roads do not.
 *
 * On a collision the LOCAL row wins regardless of score: it carries a citySlug
 * and, for a listing, a slug — things the remote row cannot supply and the UI
 * needs to act on a selection.
 */
function dedupeKey(result: GeocodeResult): string {
  const label = result.label.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${label}@${result.lat.toFixed(3)},${result.lng.toFixed(3)}`;
}

function mergeTiers(local: GeocodeResult[], remote: GeocodeResult[]): GeocodeResult[] {
  const byKey = new Map<string, GeocodeResult>();

  for (const result of local) {
    byKey.set(dedupeKey(result), result);
  }

  for (const result of remote) {
    const key = dedupeKey(result);
    if (!byKey.has(key)) byKey.set(key, result);
  }

  return [...byKey.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // A stable tiebreak, so the same query never reorders between keystrokes.
    return a.label.localeCompare(b.label);
  });
}

export async function suggestPlaces(
  query: PlaceSearchQuery,
  options: { signal?: AbortSignal } = {},
): Promise<PlaceSuggestions> {
  const term = query.q.trim();
  const sources: GeocodeSource[] = [];

  if (term.length === 0) {
    return { suggestions: [], sources, state: 'ok' };
  }

  const localRows = await searchPlacesLocally({
    query: term,
    ...(query.citySlug ? { citySlug: query.citySlug } : {}),
    // Over-fetch a little so de-duplication cannot shrink the page below `limit`.
    limit: Math.min(40, query.limit * 2),
  });

  const local = localRows.map(toGeocodeResult);
  if (local.length > 0) sources.push('local');

  // Tier 2 is skipped when tier 1 already answered well, and for very short
  // queries where a remote geocoder returns noise anyway — "ko" against
  // Nominatim is not a useful request to make of a shared free service.
  const needsRemote =
    term.length >= AUTOCOMPLETE_MIN_REMOTE_CHARS &&
    local.length < AUTOCOMPLETE_LOCAL_SUFFICIENT_COUNT;

  if (!needsRemote) {
    return {
      suggestions: local.slice(0, query.limit),
      sources,
      // `ok`, not degraded: tier 1 was sufficient, which is the fast path, not
      // a failure. A locally-answered query is the good case.
      state: 'ok',
    };
  }

  const remote = await resolveGeocodeProvider().search(term, {
    ...(query.citySlug ? { citySlug: query.citySlug } : {}),
    limit: query.limit,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (remote.results.length > 0) sources.push('nominatim');

  const suggestions = mergeTiers(local, remote.results).slice(0, query.limit);

  // Tier 2 was needed and could not answer: down, still importing, or rate
  // limited. The local rows still stand, and the UI says so rather than
  // implying the place does not exist. This is NOT the same as tier 2
  // answering with an empty list, which is a fact about the extract — and
  // reading `results.length === 0` as "degraded" is what made the two
  // indistinguishable before correction 9.
  if (remote.refused) {
    return { suggestions, sources, state: 'degraded' };
  }

  // Both tiers answered, both empty, and the query reads like a place name.
  // Almost always a city the product does not serve, and that deserves the
  // coverage message rather than an empty list a user reads as "this product
  // has nothing".
  if (suggestions.length === 0 && looksLikePlaceName(term)) {
    return {
      suggestions,
      sources,
      state: OUT_OF_COVERAGE_CODE,
      coverage: outOfCoverageForQuery(),
    };
  }

  return { suggestions, sources, state: 'ok' };
}

/**
 * Reverse geocode for map-click and pin-drag office selection.
 *
 * Coverage first, and the reason is what a null `place` used to mean: "there is
 * no address at this point" and "the product does not reach this point" were
 * the same answer, so a pin dropped in Mumbai looked identical to a pin dropped
 * on an unmapped field at the edge of Patna. The first wants the coverage
 * state; the second is legitimate and shows coordinates.
 */
export async function reversePlace(
  coordinate: Coordinate,
  options: { signal?: AbortSignal } = {},
): Promise<ReversePlaceResponse> {
  const coverage = await checkCoverage(coordinate);

  if (!coverage.covered) {
    return {
      place: null,
      coverage: outOfCoverageFor({ coordinate, nearest: coverage.nearest }),
    };
  }

  const place = await resolveGeocodeProvider().reverse(coordinate, options);
  return { place };
}
