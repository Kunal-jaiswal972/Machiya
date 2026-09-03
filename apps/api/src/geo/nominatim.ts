import {
  CACHE_TTL_SECONDS,
  type Coordinate,
  type GeocodeProvider,
  type GeocodeResult,
  type GeocodeSearchOptions,
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
  if (place.class === 'place') {
    if (place.type === 'city' || place.type === 'town') return 'city';
    if (place.type === 'suburb' || place.type === 'neighbourhood' || place.type === 'quarter') {
      return 'locality';
    }
  }
  if (place.class === 'highway' || place.class === 'building' || place.class === 'place') {
    return 'address';
  }
  return 'poi';
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

function toResult(place: NominatimPlace): GeocodeResult {
  const { label, context } = splitDisplayName(place);

  return {
    id: `nominatim:${String(place.place_id)}`,
    label,
    context,
    lat: Number(place.lat),
    lng: Number(place.lon),
    kind: kindFor(place),
    source: 'nominatim',
    // Nominatim's importance is already 0-1 but clusters low, so it is scaled
    // to sit under a tier-1 prefix match (0.92) and above a weak trigram one.
    // The two tiers have to be comparable or merging them is arbitrary.
    score: Math.min(0.9, Math.max(0.1, (place.importance ?? 0.3) * 1.6)),
  };
}

async function requestJson(url: URL, signal?: AbortSignal): Promise<unknown> {
  // The public instance rejects requests without a descriptive User-Agent and a
  // real contact address, and the self-hosted one does not care — so it is
  // always sent, and NOMINATIM_USER_AGENT must be set before pointing
  // NOMINATIM_URL at the public host.
  const response = await fetch(url, {
    headers: { 'user-agent': env.NOMINATIM_USER_AGENT, accept: 'application/json' },
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

  async search(query: string, options: GeocodeSearchOptions = {}): Promise<GeocodeResult[]> {
    const term = normalizeQueryKey(query);
    if (term.length === 0) return [];

    const limit = options.limit ?? 8;
    // Epoch-prefixed like the others: Nominatim's answers come from the
    // imported extract, so they are as derived as a route is. The 7-day TTL is
    // about churn; the epoch is what makes it CORRECT across a rebuild.
    const key = geoCacheKey('geocode', term, options.citySlug ?? 'all', limit);

    try {
      const { value } = await cached<GeocodeResult[]>({
        key,
        ttlSeconds: CACHE_TTL_SECONDS.geocode,
        load: async () => {
          const url = new URL('/search', this.baseUrl);
          url.searchParams.set('q', term);
          url.searchParams.set('format', 'jsonv2');
          url.searchParams.set('limit', String(limit));
          url.searchParams.set('namedetails', '1');
          url.searchParams.set('addressdetails', '0');
          // Everything this product serves is in India, and the constraint cuts
          // out a surprising number of same-named places elsewhere.
          url.searchParams.set('countrycodes', 'in');

          const payload = await requestJson(url, options.signal);
          return nominatimSearchSchema.parse(payload).map(toResult);
        },
      });

      return value;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // The user kept typing. Not a failure; the newer request answers.
        return [];
      }

      // Tier 2 refusing is an ordinary state — an import still running, a rate
      // limit, no network. The endpoint degrades to the local tier.
      logger.warn({ err: error, term }, 'nominatim search failed');
      return [];
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
