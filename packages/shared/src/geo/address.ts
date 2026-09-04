/**
 * Address precision, and what to do about an address the geocoder cannot parse.
 *
 * Within a covered city the geocoder resolves what OSM contains: roads,
 * localities and named POIs. A specific house number usually does not resolve,
 * because `addr:housenumber` tagging in Indian cities is sparse — and that is
 * not fixable by changing geocoder. Nominatim can only return what is in the
 * extract, and the commercial address data that would resolve "House 47, Road
 * 3, Rajendra Nagar" is exactly what this project excluded on purpose.
 *
 * So the product is honest about it and degrades usefully. This module holds
 * the two pieces that decision needs: a precision label the UI can say out
 * loud, and the conservative strip that turns a dead-end address into a
 * useful area. Both are measured behaviour, not guesses — see `docs/geo.md`
 * for the query set and DECISIONS.md D58.
 */
import { z } from 'zod';

/**
 * How precise an answer is **relative to the question**.
 *
 * Three values because there are three honest things to say, and each maps to
 * one sentence of copy:
 *
 *  - `exact` — resolved to a specific feature: a building, a named POI, an
 *    address with a real house number. "This is the place."
 *  - `locality` — resolved to a named neighbourhood, a suburb or a **road**.
 *    "This is the right street or area; drag the pin to your exact spot."
 *    A road belongs here rather than in `exact`: finding Bailey Road when
 *    someone typed "Flat 3, Bailey Road" means we found their street, not
 *    their flat.
 *  - `area` — resolved only to a city or district. Much broader than asked.
 */
export const matchPrecisionSchema = z.enum(['exact', 'locality', 'area']);

export type MatchPrecision = z.infer<typeof matchPrecisionSchema>;

/** Coarsest first, so `capPrecision` can compare. */
const PRECISION_ORDER: MatchPrecision[] = ['exact', 'locality', 'area'];

/**
 * Never claim more precision than `limit`.
 *
 * The rule that makes the stripped retry safe: a result that answered a query
 * with the house number **removed** cannot be `exact`, even when the feature it
 * matched is a building — it is not the building that was asked about. Capping
 * turns a confidently wrong answer into a labelled guess, which is the whole
 * difference between the two.
 */
export function capPrecision(precision: MatchPrecision, limit: MatchPrecision): MatchPrecision {
  return PRECISION_ORDER.indexOf(precision) >= PRECISION_ORDER.indexOf(limit) ? precision : limit;
}

/**
 * One house-number-like fragment: a bare number, a number with a letter suffix,
 * or a House/H.No/Flat/Plot/Door/No/# prefix followed by one.
 *
 * Deliberately narrow. "Road 3" and "5th Block" are NOT house numbers, and a
 * pattern loose enough to eat them would turn "Road 3, Rajendra Nagar" into
 * "Rajendra Nagar" by accident in some queries and into nothing in others.
 */
const HOUSE_NUMBER = String.raw`(?:(?:h\.?\s*no\.?|house|flat|plot|door|no\.?|#)\s*)?\d+\s*[a-z]?`;

const HOUSE_NUMBER_SEGMENT = new RegExp(`^${HOUSE_NUMBER}$`, 'i');
const HOUSE_NUMBER_PREFIX = new RegExp(`^${HOUSE_NUMBER}\\b\\s*,?\\s*`, 'i');

/**
 * Whether a query reads as a street address rather than as a place name.
 *
 * Used for two things: deciding whether a strip is worth attempting, and
 * demoting our own listing rows in the local tier — somebody typing
 * "80 Feet Road, 4th Block, Koramangala" is looking for a place on a map, not
 * for a listing whose title happens to contain "Koramangala".
 */
export function looksLikeStreetAddress(query: string): boolean {
  return stripHouseNumber(query) !== null;
}

/**
 * The one retry: the same query with leading house-number fragments removed, or
 * null when there is nothing to remove.
 *
 * **Why leading only, and why one pass.** The measured failure is specific:
 * Nominatim's `/search` parses a comma-separated query structurally and returns
 * **nothing at all** rather than a partial match when the leading component is a
 * house number it cannot place. "House 12, Anisabad, Patna" returns zero;
 * "Anisabad, Patna" returns the neighbourhood. Space-separated queries mostly
 * survive the house number already — "12B Boring Road Patna" finds Boring Road
 * untouched — so this is aimed at the comma form, where it is the difference
 * between an answer and a dead end.
 *
 * Progressive truncation until something matches is deliberately NOT done. It
 * turns a bad query into a confidently wrong answer: dropping tokens off
 * "47 Road 3 Rajendra Nagar Patna" until Nominatim bites lands on
 * "90 Feet Road", which is a real road in Patna and not the one asked for.
 * One strip, one retry, and the result capped at `locality` precision.
 */
export function stripHouseNumber(query: string): string | null {
  const term = query.trim();
  if (term.length === 0) return null;

  if (term.includes(',')) {
    const segments = term
      .split(',')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    // Drop leading segments that are ENTIRELY a house number, and stop at the
    // first that is not. "House 47, Road 3, Rajendra Nagar" loses "House 47"
    // and keeps "Road 3" — which is a road name, not a house number, however
    // much it looks like one out of context.
    let start = 0;
    while (start < segments.length - 1 && HOUSE_NUMBER_SEGMENT.test(segments[start] ?? '')) {
      start += 1;
    }

    if (start === 0) {
      // No leading house-number segment, but the first segment may still START
      // with one: "221 Sarjapur Road, Bellandur".
      const first = segments[0] ?? '';
      const trimmed = first.replace(HOUSE_NUMBER_PREFIX, '');
      if (trimmed.length === 0 || trimmed === first) return null;
      return [trimmed, ...segments.slice(1)].join(', ');
    }

    return segments.slice(start).join(', ');
  }

  const stripped = term.replace(HOUSE_NUMBER_PREFIX, '');
  if (stripped.length === 0 || stripped === term) return null;
  return stripped;
}

/**
 * What to tell someone about the answer they just picked, or null when there is
 * nothing worth saying.
 *
 * `exact` returns null on purpose. A precise answer is the good case and needs
 * no note — and "never apologise for a fast path" cuts both ways: a product
 * that annotates its successes trains people to distrust them.
 */
export function precisionNote(input: { precision: MatchPrecision; label: string }): string | null {
  switch (input.precision) {
    case 'exact':
      return null;
    case 'locality':
      return `Showing ${input.label} — drag the pin to your exact spot.`;
    case 'area':
      return `Showing ${input.label}, which covers a wide area — drag the pin to your exact spot.`;
  }
}
