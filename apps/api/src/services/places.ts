import { searchPlacesLocally, type LocalPlaceRow } from '@machiya/db';
import {
  AUTOCOMPLETE_CONFIDENT_SCORE,
  AUTOCOMPLETE_LOCAL_SUFFICIENT_COUNT,
  AUTOCOMPLETE_MIN_REMOTE_CHARS,
  OUT_OF_COVERAGE_CODE,
  cityBboxSchema,
  looksLikePlaceName,
  looksLikeStreetAddress,
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
    matchPrecision: row.matchPrecision,
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

  // Over-fetch a little so de-duplication cannot shrink the page below `limit`.
  const localLimit = Math.min(40, query.limit * 2);

  const localRows = await searchPlacesLocally({
    query: term,
    ...(query.citySlug ? { citySlug: query.citySlug } : {}),
    limit: localLimit,
  });

  /**
   * No stripping here, and that is a measured decision rather than an omission.
   *
   * Tier 1 is **already** a fuzzy search — `pg_trgm` trigram similarity — and it
   * degrades a full street address to its locality unaided. Against the seeded
   * database, "House 47, Road 3, Rajendra Nagar, Patna" returns
   * `Rajendra Nagar` as its top row at similarity 0.42, and
   * "Flat 4B, 21 Patliputra Colony, Patna" returns `Patliputra Colony` at 0.56.
   * A pre-stripped second local query would be a slower way to get the row
   * trigram already found.
   *
   * What tier 1 cannot do is answer for a locality that is not one of its
   * rows — Anisabad, Wakad and Bellandur all return only the city. That gap is
   * tier 2's, and it is the only place a strip earns its keep. See D58.
   */
  const local = localRows.map(toGeocodeResult);

  if (local.length > 0) sources.push('local');

  /**
   * Whether tier 1 actually ANSWERED, as opposed to merely returning rows.
   *
   * A place row counts at any score — a weak trigram hit on a locality name is
   * still that locality, and it is the kind of answer this box exists to give.
   * A listing row has to clear `AUTOCOMPLETE_CONFIDENT_SCORE`.
   *
   * The distinction was found live. "Flat 3, Bailey Road, Patna" returned eight
   * listing rows at 0.117 — every flat in Boring Road, which shares trigrams
   * with Bailey Road — and a plain count of five was enough to suppress tier 2
   * and never ask Nominatim, which knows Bailey Road. The user got eight
   * unrelated flats instead of their street.
   */
  const confident = local.filter(
    (result) => result.kind !== 'listing' || result.score >= AUTOCOMPLETE_CONFIDENT_SCORE,
  ).length;

  // Tier 2 is skipped when tier 1 already answered well, and for very short
  // queries where a remote geocoder returns noise anyway — "ko" against
  // Nominatim is not a useful request to make of a shared free service.
  const needsRemote =
    term.length >= AUTOCOMPLETE_MIN_REMOTE_CHARS && confident < AUTOCOMPLETE_LOCAL_SUFFICIENT_COUNT;

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

  /**
   * Both tiers answered, both empty, and the query reads like a place NAME
   * rather than a street address.
   *
   * The street-address exclusion is the line between corrections 9 and 10, and
   * it was missing until it showed up live: "221 Sarjapur Road, Bellandur,
   * Bengaluru" resolves to nothing here — Bellandur is not one of our
   * `Locality` rows and Nominatim has no match for that string — and the
   * coverage message answered it with "Machiya covers Patna, Bengaluru and
   * Pune." For an address IN Bengaluru that is a non-sequitur, and precisely
   * the confusion the coverage state exists to remove.
   *
   * So: an address we cannot resolve is an address problem, and gets the
   * address message. A place name we cannot resolve anywhere is a coverage
   * problem, and gets the coverage message.
   */
  if (suggestions.length === 0 && looksLikePlaceName(term) && !looksLikeStreetAddress(term)) {
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
