import {
  CACHE_TTL_SECONDS,
  capPrecision,
  stripHouseNumber,
  type Coordinate,
  type GeocodeProvider,
  type GeocodeResult,
  type GeocodeSearchOptions,
  type GeocodeSearchOutcome,
  type MatchPrecision,
} from '@machiya/shared';
import { z } from 'zod';
import { env } from '../env.js';
import { cached, normalizeQueryKey } from '../lib/cache.js';
import { geoCacheKey } from './manifest.js';
import { logger } from '../logger.js';

/**
 * Tier 2 of the autocomplete, and the only geocoder.
 *
 * This is the one concrete `GeocodeProvider`. Feature code never imports it —
 * it goes through `resolveGeocodeProvider()` below, selected by
 * `GEOCODE_PROVIDER` — so adding a second geocoder means adding a file and an
 * enum value, not touching call sites. Photon was evaluated and removed; see
 * DECISIONS.md D26.
 *
 * Every lookup is cached in Redis for seven days under a normalised query, which
 * is what makes a repeated search free. The public instance's usage policy asks
 * for exactly that, and the self-hosted one benefits anyway.
 */

// Nominatim's response has far more fields than this. Only what is used is
// declared, and `passthrough` is deliberately absent: a shape change should
// surface here rather than as an undefined three layers up.
const nominatimPlaceSchema = z.object({
  place_id: z.union([z.number(), z.string()]),
  osm_type: z.string().optional(),
  osm_id: z.union([z.number(), z.string()]).optional(),
  lat: z.string(),
  lon: z.string(),
  display_name: z.string(),
  /** Present with `namedetails=1`; the short label, without the tail. */
  name: z.string().nullish(),
  class: z.string().optional(),
  type: z.string().optional(),
  /** jsonv2's name for `class` since Nominatim 4; both are read. */
  category: z.string().optional(),
  /** 0-1 already, and Nominatim's own ranking — reused rather than recomputed. */
  importance: z.number().optional(),
});

type NominatimPlace = z.infer<typeof nominatimPlaceSchema>;

const nominatimSearchSchema = z.array(nominatimPlaceSchema);

/**
 * Which of the seven `GeocodeResultKind` values a Nominatim class/type is.
 *
 * Coarse on purpose (see the kind enum's own comment): the UI groups and the
 * ranking weights by this, and mapping Nominatim's full taxonomy through would
 * leak its vocabulary into the client.
 */
function kindFor(place: NominatimPlace): GeocodeResult['kind'] {
  const category = categoryOf(place);

  if (category === 'place') {
    if (place.type === 'city' || place.type === 'town') return 'city';
    if (place.type === 'suburb' || place.type === 'neighbourhood' || place.type === 'quarter') {
      return 'locality';
    }
  }
  if (category === 'highway' || category === 'building' || category === 'place') {
    return 'address';
  }
  return 'poi';
}

/**
 * Nominatim renamed `class` to `category` in the jsonv2 output.
 *
 * Both are read, oldest last, because the schema keeps `class` optional and a
 * silent `undefined` here would send every result down the `poi` branch — which
 * is what makes a suburb look like a shop. The local instance answers with
 * `category`; verified by reading a raw `/search` response.
 */
function categoryOf(place: NominatimPlace): string | undefined {
  return place.category ?? place.class;
}

/**
 * How precise the answer is, relative to the question.
 *
 * Derived from what the result IS, not from how it was found, because that is
 * the only honest basis: a `place/suburb` hit is a neighbourhood whether it came
 * from the original query or from the stripped retry. What the retry changes is
 * the CEILING, applied by the caller — see `search`.
 *
 * A road is `locality`, deliberately. Finding Bailey Road for "Flat 3, Bailey
 * Road" means we found the street and not the flat, and calling that `exact`
 * would promise a precision the answer does not have. Measured: of ten real
 * addresses with house numbers across the three cities, **one** resolved to an
 * actual `addr:housenumber`, and that one was the wrong number on a café.
 */
function precisionFor(place: NominatimPlace): MatchPrecision {
  const category = categoryOf(place);

  if (category === 'place') {
    if (place.type === 'city' || place.type === 'town' || place.type === 'state') return 'area';
    if (place.type === 'county' || place.type === 'district' || place.type === 'region') {
      return 'area';
    }
    return 'locality';
  }

  if (category === 'boundary') return 'area';
  if (category === 'highway' || category === 'landuse') return 'locality';

  // A building, a shop, an amenity, a named POI: a specific thing.
  return 'exact';
}

/**
 * Splits `display_name` into a label and the context line under it.
 *
 * Nominatim returns the whole administrative chain — "Koramangala, Bengaluru
 * South, Bengaluru Urban, Karnataka, 560034, India" — which is unreadable in a
 * dropdown row. The first component is the label, the next two are the context,
 * and the country and postcode are dropped because everything here is in India.
 */
function splitDisplayName(place: NominatimPlace): { label: string; context?: string } {
  const parts = place.display_name
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const label = place.name?.trim() || parts[0] || place.display_name;
  const rest = parts
    .filter((part) => part !== label)
    .filter((part) => part !== 'India' && !/^\d{5,6}$/.test(part))
    .slice(0, 2);

  return { label, context: rest.length > 0 ? rest.join(', ') : undefined };
}

/**
 * Nominatim's `importance`, mapped onto the same 0-1 scale tier 1 uses.
 *
 * Two problems with the obvious `max(floor, importance * k)`, both found by
 * measuring rather than reading:
 *
 *  1. **importance clusters very low.** An ordinary residential road scores
 *     around 0.053 — Bailey Road in Patna is exactly 0.0533 — which the old
 *     0.1 floor put BELOW a junk trigram match. Eight "apartment in Boring
 *     Road" rows at 0.117 buried the road the user had actually typed. A
 *     result Nominatim returned at all is a real named feature in the extract;
 *     a 0.117 trigram hit is noise.
 *  2. **a hard floor FLATTENS the low range**, which is where almost
 *     everything lands. Six Bailey Roads and a suburb all pinned to 0.25 left
 *     the alphabetical tiebreak choosing the winner, and it chose "Ahmed
 *     Enclave" over "Anisabad" for a query that said Anisabad.
 *
 * So the range is LIFTED rather than clipped: 0.25 to 0.90, monotonic, so
 * ordering survives. 0.25 sits above trigram noise and below every genuine
 * local place match (a prefix hit is 0.92, an exact one 1.0).
 *
 * The small bonus for a locality or a city is the same principle as demoting
 * listing rows in tier 1: a named neighbourhood answers "where is your office"
 * better than a road does, and for "House 12, Anisabad, Patna" the suburb is
 * what the user named.
 */
const SCORE_FLOOR = 0.25;
const SCORE_CEILING = 0.9;
const PLACE_BONUS = 0.05;

function scoreFor(place: NominatimPlace, kind: GeocodeResult['kind']): number {
  const base = Math.min(1, Math.max(0, (place.importance ?? 0.3) * 1.6));
  const lifted = SCORE_FLOOR + (SCORE_CEILING - SCORE_FLOOR) * base;

  // The bonus is keyed on OSM's own `place` category rather than on our coarser
  // `kind`, so a `place/square` counts as a place. For "House 12, Anisabad,
  // Patna" that is the difference between offering Anisabad Golamber and
  // offering a children's park that happens to be in Anisabad — both are in
  // the right neighbourhood, but only one of them is the neighbourhood.
  const bonus =
    categoryOf(place) === 'place' || kind === 'locality' || kind === 'city' ? PLACE_BONUS : 0;

  return Math.min(SCORE_CEILING, lifted + bonus);
}

function toResult(place: NominatimPlace, precisionLimit?: MatchPrecision): GeocodeResult {
  const { label, context } = splitDisplayName(place);
  const precision = precisionFor(place);
  const kind = kindFor(place);

  return {
    id: `nominatim:${String(place.place_id)}`,
    label,
    context,
    lat: Number(place.lat),
    lng: Number(place.lon),
    kind,
    source: 'nominatim',
    matchPrecision: precisionLimit ? capPrecision(precision, precisionLimit) : precision,
    score: scoreFor(place, kind),
  };
}

/**
 * Commas out, whitespace collapsed — free text rather than a structured query.
 *
 * Nominatim treats a comma-separated `q` as a structured address and matches it
 * component by component. Handing it the same words as free text lets its own
 * fuzzy matching work instead, and measured across ten real addresses it never
 * did worse and once did much better: "#118, 5th Block, Koramangala, Bengaluru"
 * returns a **hotel** with the commas and `Koramangala 5th Block`
 * (place/neighbourhood) without them.
 *
 * It is not, on its own, the fix for a dead-end address. Eight of those ten
 * returned nothing with or without commas, which is why the stripped retry in
 * `search` exists as well — the strings are genuinely absent from the extract,
 * not merely mis-parsed.
 */
function freeText(term: string): string {
  return term.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
}

async function requestJson(url: URL, signal?: AbortSignal): Promise<unknown> {
  // The public instance rejects requests without a descriptive User-Agent and a
  // real contact address, and the self-hosted one does not care — so it is
  // always sent, and GEO_USER_AGENT must be set before pointing
  // NOMINATIM_URL at the public host.
  const response = await fetch(url, {
    headers: { 'user-agent': env.GEO_USER_AGENT, accept: 'application/json' },
    // Both signals: the caller's abort AND a ceiling. Passing only the
    // caller's would leave a hung upstream holding the request open.
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5_000)]),
  });

  if (!response.ok) {
    throw new Error(`nominatim ${String(response.status)} for ${url.pathname}`);
  }

  return response.json();
}

export class NominatimGeocodeProvider implements GeocodeProvider {
  readonly name = 'nominatim' as const;

  constructor(private readonly baseUrl: string = env.NOMINATIM_URL) {}

  /**
   * One `/search` call. No retry logic here — `search` owns that.
   *
   * `precisionLimit` is how the stripped retry stays honest: results from a
   * query with the house number removed can never be `exact`.
   */
  private async fetchSearch(input: {
    term: string;
    limit: number;
    precisionLimit?: MatchPrecision;
    signal?: AbortSignal;
  }): Promise<GeocodeResult[]> {
    const url = new URL('/search', this.baseUrl);
    url.searchParams.set('q', freeText(input.term));
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', String(input.limit));
    url.searchParams.set('namedetails', '1');
    url.searchParams.set('addressdetails', '0');
    // Everything this product serves is in India, and the constraint cuts out a
    // surprising number of same-named places elsewhere.
    url.searchParams.set('countrycodes', 'in');

    const payload = await requestJson(url, input.signal);
    return nominatimSearchSchema
      .parse(payload)
      .map((place) => toResult(place, input.precisionLimit));
  }

  async search(query: string, options: GeocodeSearchOptions = {}): Promise<GeocodeSearchOutcome> {
    const term = normalizeQueryKey(query);
    if (term.length === 0) return { results: [], refused: false };

    const limit = options.limit ?? 8;
    // Epoch-prefixed like the others: Nominatim's answers come from the
    // imported extract, so they are as derived as a route is. The 7-day TTL is
    // about churn; the epoch is what makes it CORRECT across a rebuild.
    //
    // The key is the NORMALISED ORIGINAL query, and the stripped retry is
    // cached under it too. That is the point of caching the outcome rather than
    // each call: the same dead-end address costs two upstream requests once,
    // not twice on every keystroke that reaches it.
    const key = geoCacheKey('geocode', term, options.citySlug ?? 'all', limit);

    try {
      const { value } = await cached<GeocodeResult[]>({
        key,
        ttlSeconds: CACHE_TTL_SECONDS.geocode,
        load: async () => {
          const direct = await this.fetchSearch({
            term,
            limit,
            ...(options.signal ? { signal: options.signal } : {}),
          });

          if (direct.length > 0) return direct;

          // Zero results. `/search` parses a comma-separated query
          // structurally and returns NOTHING rather than a partial match when
          // it cannot place the leading house number: "House 12, Anisabad,
          // Patna" is empty while "Anisabad, Patna" is not. So retry ONCE with
          // the house number stripped — and only once, because truncating
          // until something matches turns a bad query into a confidently wrong
          // answer. See DECISIONS.md D58.
          const stripped = stripHouseNumber(term);
          if (!stripped) return direct;

          logger.debug({ term, stripped }, 'nominatim retrying without the house number');

          return this.fetchSearch({
            term: stripped,
            limit,
            // The ceiling that keeps this from lying. The house number is gone,
            // so even a building hit is not the building that was asked about.
            precisionLimit: 'locality',
            ...(options.signal ? { signal: options.signal } : {}),
          });
        },
      });

      // An EMPTY list here is an answer, not a failure: the extract holds three
      // cities and this instance was asked about a fourth. `refused: false` is
      // what lets the caller reach for the coverage message instead of the
      // degraded one — see `GeocodeSearchOutcome`.
      return { results: value, refused: false };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // The user kept typing. Not a failure, but not an answer either — a
        // newer request will answer, and calling this `refused: false` would
        // let an aborted keystroke produce a coverage message for a query that
        // was never actually asked.
        return { results: [], refused: true };
      }

      // Tier 2 refusing is an ordinary state — an import still running, a rate
      // limit, no network. The endpoint degrades to the local tier.
      logger.warn({ err: error, term }, 'nominatim search failed');
      return { results: [], refused: true };
    }
  }

  async reverse(
    coordinate: Coordinate,
    options: { signal?: AbortSignal } = {},
  ): Promise<GeocodeResult | null> {
    // Rounded to about 11 m before it becomes a cache key: a pin dragged by one
    // pixel is the same address, and full precision would make every drag a miss.
    const lat = coordinate.lat.toFixed(4);
    const lng = coordinate.lng.toFixed(4);
    const key = geoCacheKey('geocode', 'reverse', `${lat},${lng}`);

    try {
      const { value } = await cached<GeocodeResult | null>({
        key,
        ttlSeconds: CACHE_TTL_SECONDS.geocode,
        load: async () => {
          const url = new URL('/reverse', this.baseUrl);
          url.searchParams.set('lat', lat);
          url.searchParams.set('lon', lng);
          url.searchParams.set('format', 'jsonv2');
          url.searchParams.set('namedetails', '1');

          const payload = await requestJson(url, options.signal);
          const parsed = nominatimPlaceSchema.safeParse(payload);
          // Over water or outside the imported extract, Nominatim answers with
          // an error object rather than a place. That is a legitimate "no
          // address here", not a fault.
          //
          // Precision is derived, not assumed exact: a reverse lookup of a
          // dropped pin frequently comes back as the enclosing suburb or city
          // rather than the building — measured at Golghar, where it answers
          // "Patna". The wizard reads this to decide whether to prefill a
          // street line at all (D59).
          return parsed.success ? toResult(parsed.data) : null;
        },
      });

      return value;
    } catch (error) {
      logger.warn({ err: error, lat, lng }, 'nominatim reverse failed');
      return null;
    }
  }
}

let provider: GeocodeProvider | undefined;

/**
 * The single place a geocoder is chosen. `GEOCODE_PROVIDER` has one value today
 * and the switch is still explicit, so the next provider is an added branch
 * rather than an archaeology exercise.
 */
export function resolveGeocodeProvider(): GeocodeProvider {
  if (provider) return provider;

  switch (env.GEOCODE_PROVIDER) {
    case 'nominatim':
      provider = new NominatimGeocodeProvider();
      return provider;
  }
}
