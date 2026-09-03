import {
  CACHE_TTL_SECONDS,
  POI_CATEGORIES,
  type Coordinate,
  type Poi,
  type PoiCategory,
  type PoiLookupResult,
  type PoiProvider,
} from '@machiya/shared';
import { z } from 'zod';
import { env } from '../env.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { geoCacheKey } from './manifest.js';
import { logger } from '../logger.js';

/**
 * Nearby places, from Overpass.
 *
 * **One batched query per listing, not one per category.** Seven sequential
 * requests to a free Overpass mirror will be rate-limited where one is
 * tolerated, and the whole panel appears at once instead of filling in seven
 * steps. The query below is a single `[out:json]` block with a union of seven
 * selectors, each tagged with the category it belongs to.
 *
 * On a 429 or a timeout the answer is **cached-or-empty with `degraded: true`**,
 * never an error. The sidebar then says "couldn't refresh nearby places" instead
 * of "none nearby", because to someone choosing where to live those are opposite
 * statements.
 */
interface Selector {
  filter: string;
  /**
   * Whether to also query ways. Only for things mapped as buildings or
   * campuses: asking for `way["amenity"="atm"]` doubles the query's cost for
   * results that do not exist, and a seven-category query is already the
   * expensive part of the detail view.
   */
  ways?: boolean;
}

const OVERPASS_SELECTORS: Record<PoiCategory, Selector[]> = {
  hospital: [{ filter: '["amenity"="hospital"]', ways: true }, { filter: '["amenity"="clinic"]' }],
  police: [{ filter: '["amenity"="police"]' }],
  school: [
    { filter: '["amenity"="school"]', ways: true },
    { filter: '["amenity"="college"]', ways: true },
  ],
  pharmacy: [{ filter: '["amenity"="pharmacy"]' }],
  atm: [{ filter: '["amenity"="atm"]' }, { filter: '["amenity"="bank"]' }],
  supermarket: [
    { filter: '["shop"="supermarket"]', ways: true },
    { filter: '["shop"="convenience"]' },
  ],
  transit: [
    { filter: '["railway"="station"]' },
    { filter: '["railway"="subway_entrance"]' },
    { filter: '["highway"="bus_stop"]' },
    { filter: '["amenity"="bus_station"]' },
  ],
};

const overpassElementSchema = z.object({
  type: z.enum(['node', 'way', 'relation']),
  id: z.number(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  /** Ways and relations carry their centre instead of a point. */
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

const overpassResponseSchema = z.object({
  elements: z.array(overpassElementSchema).default([]),
});

type OverpassElement = z.infer<typeof overpassElementSchema>;

/**
 * Which category an element belongs to, from its tags.
 *
 * Overpass has no way to label a result with the selector that matched it, so
 * the tags are re-read here. The order matters: a hospital pharmacy is a
 * hospital, and a bank with an ATM is an ATM only if it is not also a bank —
 * so the first match in the fixed order below wins, and it is the same order the
 * legend uses.
 */
function categoryFor(tags: Record<string, string>): PoiCategory | null {
  const amenity = tags.amenity;
  const shop = tags.shop;
  const railway = tags.railway;
  const highway = tags.highway;

  if (amenity === 'hospital' || amenity === 'clinic') return 'hospital';
  if (amenity === 'police') return 'police';
  if (amenity === 'school' || amenity === 'college') return 'school';
  if (amenity === 'pharmacy') return 'pharmacy';
  if (amenity === 'atm' || amenity === 'bank') return 'atm';
  if (shop === 'supermarket' || shop === 'convenience') return 'supermarket';
  if (
    railway === 'station' ||
    railway === 'subway_entrance' ||
    highway === 'bus_stop' ||
    amenity === 'bus_station'
  ) {
    return 'transit';
  }

  return null;
}

/** Haversine. The POI list is sorted and truncated by this, per category. */
function distanceMeters(from: Coordinate, to: Coordinate): number {
  const earthRadius = 6_371_000;
  const toRad = (degrees: number): number => (degrees * Math.PI) / 180;

  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLng / 2) ** 2;

  return 2 * earthRadius * Math.asin(Math.sqrt(a));
}

function buildQuery(
  center: Coordinate,
  radiusMeters: number,
  categories: readonly PoiCategory[],
): string {
  const around = `(around:${String(Math.round(radiusMeters))},${String(center.lat)},${String(center.lng)})`;

  const clauses = categories.flatMap((category) =>
    (OVERPASS_SELECTORS[category] ?? []).flatMap((selector) => [
      `node${selector.filter}${around};`,
      ...(selector.ways ? [`way${selector.filter}${around};`] : []),
    ]),
  );

  // `out center` gives ways a single point, so a hospital campus is one marker
  // rather than a polygon the client would have to reduce itself.
  return [
    `[out:json][timeout:${String(Math.round(env.OVERPASS_TIMEOUT_MS / 1000))}];`,
    '(',
    ...clauses,
    ');',
    'out center tags;',
  ].join('\n');
}

/** How many of each category are kept. A legend with 200 pharmacies is a mess. */
const MAX_PER_CATEGORY = 12;

/**
 * The category component of a cache key: `all` for the full set, so the key
 * every real caller uses stays readable, and a sorted list otherwise.
 */
function categoryKeyPart(categories: readonly PoiCategory[]): string {
  const unique = [...new Set(categories)].sort();
  return unique.length === POI_CATEGORIES.length ? 'all' : unique.join('+');
}

export class OverpassPoiProvider implements PoiProvider {
  readonly name = 'overpass';

  /**
   * In-flight keys, so ten viewers of the same listing produce one Overpass
   * query rather than ten. Process-local, which is correct here: a second API
   * replica doing its own warm is one extra query, not a thundering herd, and
   * a distributed lock for a 24h-cached read is not worth the Redis round trip.
   */
  private readonly warming = new Set<string>();

  async nearby(input: {
    center: Coordinate;
    radiusMeters: number;
    categories?: readonly PoiCategory[];
    signal?: AbortSignal;
  }): Promise<PoiLookupResult> {
    const categories = input.categories ?? POI_CATEGORIES;
    // Epoch-prefixed (D46) and category-scoped. The category part is not
    // decoration: `nearby` accepts a subset, and without it a two-category
    // answer would be written over the key a seven-category caller reads.
    const key = geoCacheKey(
      'poi',
      `${input.center.lat.toFixed(4)},${input.center.lng.toFixed(4)}`,
      Math.round(input.radiusMeters),
      categoryKeyPart(categories),
    );

    const hit = await cacheGet<PoiLookupResult>(key);
    if (hit) return hit;

    /**
     * **The request never waits for Overpass.** Measured: this batched query
     * takes about 38 seconds against a healthy public mirror on a cold cache.
     * Blocking a panel on that would be indefensible, and splitting it into
     * seven fast queries just gets us rate-limited.
     *
     * So a cold read answers immediately with `degraded: true` and starts a
     * background warm. The client refetches while the answer is degraded and
     * picks up the real one within a minute; every later viewer of that
     * listing gets it from cache for 24 hours. Degraded already means "could
     * not refresh, not necessarily empty", which is exactly the state this is.
     */
    const stale = await cacheGet<PoiLookupResult>(`${key}:stale`);

    if (!this.warming.has(key)) {
      this.warming.add(key);
      // Deliberately not awaited, and deliberately not tied to the request's
      // abort signal — the whole point is that it outlives the request.
      void this.warm(key, input.center, input.radiusMeters, categories).finally(() => {
        this.warming.delete(key);
      });
    }

    // A previous day's answer is a much better one than nothing.
    if (stale) return { ...stale, degraded: true };

    return { pois: [], degraded: true, fetchedAt: new Date().toISOString() };
  }

  private async warm(
    key: string,
    center: Coordinate,
    radiusMeters: number,
    categories: readonly PoiCategory[],
  ): Promise<void> {
    try {
      const pois = await this.fetchPois(center, radiusMeters, categories);
      const result: PoiLookupResult = {
        pois,
        degraded: false,
        fetchedAt: new Date().toISOString(),
      };

      await cacheSet(key, result, CACHE_TTL_SECONDS.poi);
      // A long-lived copy under a second key, so a later 429 or timeout has
      // something to serve. Overpass refusing is routine, not exceptional.
      await cacheSet(`${key}:stale`, result, CACHE_TTL_SECONDS.poi * 14);
      logger.info({ key, count: pois.length }, 'overpass cache warmed');
    } catch (error) {
      logger.warn({ err: error, key }, 'overpass warm failed');
    }
  }

  private async fetchPois(
    center: Coordinate,
    radiusMeters: number,
    categories: readonly PoiCategory[],
    signal?: AbortSignal,
  ): Promise<Poi[]> {
    const response = await fetch(env.OVERPASS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // Both of these are required in practice, not decoration. Without an
        // Accept header and a descriptive User-Agent, overpass-api.de answers
        // **406 Not Acceptable** — verified: the identical query succeeds
        // through curl (which sends its own UA) and fails from Node's fetch,
        // which sends neither. The UA is the same one Nominatim is given, for
        // the same reason: a free tier is entitled to know who is calling.
        accept: 'application/json',
        'user-agent': env.NOMINATIM_USER_AGENT,
      },
      body: new URLSearchParams({ data: buildQuery(center, radiusMeters, categories) }),
      // BOTH signals, combined. Passing only the caller's (which is the
      // request-close signal) silently disabled the timeout — a slow mirror
      // then held the request open past 45 seconds instead of degrading at 25,
      // which is the opposite of what the timeout exists for.
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(env.OVERPASS_TIMEOUT_MS),
      ]),
    });

    if (response.status === 429 || response.status === 504) {
      // The documented way a free mirror says "slow down". Not a fault.
      throw new Error(`overpass rate limited (${String(response.status)})`);
    }

    if (!response.ok) {
      throw new Error(`overpass ${String(response.status)}`);
    }

    const parsed = overpassResponseSchema.parse(await response.json());
    const byCategory = new Map<PoiCategory, Poi[]>();

    for (const element of parsed.elements) {
      const point = pointOf(element);
      if (!point) continue;

      const category = categoryFor(element.tags ?? {});
      if (!category || !categories.includes(category)) continue;

      const list = byCategory.get(category) ?? [];
      list.push({
        id: `${element.type}/${String(element.id)}`,
        category,
        // Unnamed features are common in OSM — a bus stop usually has no name.
        // Null rather than a placeholder, so the UI decides what to show.
        name: element.tags?.name ?? null,
        lat: point.lat,
        lng: point.lng,
        distanceMeters: distanceMeters(center, point),
      });
      byCategory.set(category, list);
    }

    return [...byCategory.values()].flatMap((list) =>
      list.sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, MAX_PER_CATEGORY),
    );
  }
}

function pointOf(element: OverpassElement): Coordinate | null {
  if (element.lat !== undefined && element.lon !== undefined) {
    return { lat: element.lat, lng: element.lon };
  }
  if (element.center) {
    return { lat: element.center.lat, lng: element.center.lon };
  }
  return null;
}

let provider: PoiProvider | undefined;

export function resolvePoiProvider(): PoiProvider {
  provider ??= new OverpassPoiProvider();
  return provider;
}
