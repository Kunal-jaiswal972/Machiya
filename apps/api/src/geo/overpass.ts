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
 * Nearby places, from the **self-hosted** Overpass in the `geo` compose
 * profile, initialised from the same merged extract that feeds OSRM and
 * Nominatim (D48). A public mirror remains reachable through `OVERPASS_URL`,
 * but it is a fallback, never the default.
 *
 * **One batched query per listing, not one per category.** That rule outlived
 * the fair-use argument it was first made for: seven queries mean seven
 * `around:` scans over the same neighbourhood and seven round trips, and the
 * panel would fill in seven steps instead of appearing at once. The query
 * below is a single `[out:json]` block with a union of the seven selectors.
 *
 * A failure is now ordinary error handling rather than a politeness protocol:
 * the local service either answers or is down. Either way the answer is
 * **cached-or-empty with `degraded: true`**, never an error, and the sidebar
 * says "couldn't refresh nearby places" rather than "none nearby" — to someone
 * choosing where to live those are opposite statements. What changed is the
 * remaining cause: not a rate limit, but the geo profile not being up.
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
    // `qt` sorts by quadtile index instead of by id. D42 measured that as the
    // difference between an answer and a timeout on a public mirror, and the
    // code never actually carried it — fixed here. It stays for the local
    // instance too: ordering by id is work nobody asked for, and the client
    // re-sorts by distance regardless.
    'out center tags qt;',
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
  private readonly warming = new Map<string, Promise<void>>();

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
     * A cold read starts a background warm and waits a **bounded** moment for
     * it before giving up and answering degraded.
     *
     * Against the local instance the wait is what actually happens: the query
     * returns in about a second, so the panel is simply populated and the
     * client never polls. The bound is what keeps that from becoming a
     * dependency — an importing or wedged Overpass degrades the panel in
     * `OVERPASS_COLD_WAIT_MS` rather than holding a request open, and the
     * client's poll picks the answer up when it lands.
     *
     * The warm itself is deliberately NOT tied to the request's abort signal:
     * it outlives the request on purpose, so a user who closes the sidebar
     * still leaves the cache warm for the next viewer.
     */
    const warming = this.startWarm(key, input.center, input.radiusMeters, categories);

    const raced = await Promise.race([
      warming.then(() => cacheGet<PoiLookupResult>(key)),
      new Promise<null>((resolve) => {
        // unref'd: a pending timer must not hold the process open at shutdown.
        setTimeout(() => resolve(null), env.OVERPASS_COLD_WAIT_MS).unref();
      }),
    ]);

    if (raced) return raced;

    // A previous day's answer is a much better one than nothing.
    const stale = await cacheGet<PoiLookupResult>(`${key}:stale`);
    if (stale) return { ...stale, degraded: true };

    return { pois: [], degraded: true, fetchedAt: new Date().toISOString() };
  }

  /**
   * One warm per key, however many viewers arrive at once — process-local,
   * which is correct here: a second API replica doing its own warm is one
   * extra query, not a thundering herd, and a distributed lock for a
   * 24h-cached read is not worth the Redis round trip.
   */
  private startWarm(
    key: string,
    center: Coordinate,
    radiusMeters: number,
    categories: readonly PoiCategory[],
  ): Promise<void> {
    const existing = this.warming.get(key);
    if (existing) return existing;

    const started = this.warm(key, center, radiusMeters, categories).finally(() => {
      this.warming.delete(key);
    });

    this.warming.set(key, started);
    return started;
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
      // A long-lived copy under a second key, so a later outage has something
      // to serve. It is also what makes the geo profile being down a degraded
      // panel rather than an empty one.
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
        // Both kept for the fallback path, where they are load-bearing rather
        // than decorative: without an Accept header and a descriptive
        // User-Agent, overpass-api.de answers 406 Not Acceptable (D42). The
        // local instance does not care, and identifying ourselves costs
        // nothing.
        accept: 'application/json',
        'user-agent': env.GEO_USER_AGENT,
      },
      body: new URLSearchParams({ data: buildQuery(center, radiusMeters, categories) }),
      // BOTH signals, combined. Passing only the caller's (which is the
      // request-close signal) silently disabled the timeout — an upstream then
      // held the request open past 45 seconds instead of degrading at 25,
      // which is the opposite of what the timeout exists for (D42).
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(env.OVERPASS_TIMEOUT_MS),
      ]),
    });

    // Ordinary error handling. The 429/504 special case existed to be polite
    // to a shared service; a local instance either answers or is down, and the
    // caller degrades the panel identically either way.
    if (!response.ok) {
      throw new Error(`overpass ${String(response.status)} from ${env.OVERPASS_URL}`);
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
