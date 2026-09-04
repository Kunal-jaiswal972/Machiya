import { listingsInRadius, straightLineDistanceMeters } from '@machiya/db';
import {
  CACHE_TTL_SECONDS,
  type Coordinate,
  type ListingSearchOptions,
  type RoadDistance,
  type RouteProfile,
} from '@machiya/shared';
import { createHash } from 'node:crypto';
import { resolveRoutingProvider } from '../geo/osrm.js';
import { geoCacheKey } from '../geo/manifest.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { logger } from '../logger.js';

/**
 * Road distance from one office to every candidate listing, in one request.
 *
 * This is the machinery that lets sorting by total monthly cost live inside the
 * search query. The sort has to compare every listing in the radius — a page
 * would rank 24 arbitrary ones — and N separate route calls would be hundreds
 * of round trips per search. OSRM's `/table` answers the whole matrix at once:
 * measured, 300 destinations in about 170 ms.
 *
 * Three properties this has to have, in order of how badly getting them wrong
 * would hurt:
 *
 *  1. **No listing is ever dropped for a routing failure.** A null cell, or the
 *     whole table failing, falls back to a straight-line estimate marked
 *     `estimated`. A home vanishing from results for a reason the user cannot
 *     see is far worse than one with an approximate commute.
 *  2. **It is cached**, keyed by the geo epoch, the office and the candidate
 *     set — so paging through a sorted result does not re-measure, and the
 *     keyset stays consistent from page to page.
 *  3. **It is bounded.** The candidate set is whatever a 3 km radius holds,
 *     which is a few hundred at most; the provider chunks beyond 200.
 */

/**
 * The candidate set's identity, for the cache key.
 *
 * The ids AND the office, because either changing changes every distance. A
 * hash rather than the ids themselves: a few hundred cuids is several kilobytes
 * of Redis key, and the ids are already sorted so the hash is stable across
 * requests that filtered in a different order.
 */
function candidateHash(listingIds: readonly string[]): string {
  return createHash('sha256')
    .update([...listingIds].sort().join(','))
    .digest('hex')
    .slice(0, 16);
}

function officeKey(office: Coordinate): string {
  // ~11 m, like every other geo cache key: an office nudged by a pixel is the
  // same commute, and full precision would make every drag a miss.
  return `${office.lat.toFixed(4)},${office.lng.toFixed(4)}`;
}

/**
 * Straight-line times the usual urban detour factor, for a destination OSRM
 * could not reach.
 *
 * The same 1.35 the single-route fallback uses (D43), and marked `estimated` so
 * the card can say so. It is a worse number than a measured one and a much
 * better one than dropping the listing.
 */
const DETOUR_FACTOR = 1.35;

async function estimateFor(
  office: Coordinate,
  candidate: { id: string; lat: number; lng: number },
): Promise<RoadDistance> {
  const straightLine = await straightLineDistanceMeters(office, {
    lat: candidate.lat,
    lng: candidate.lng,
  });

  return { listingId: candidate.id, meters: straightLine * DETOUR_FACTOR, estimated: true };
}

export interface RoadDistanceResult {
  distances: RoadDistance[];
  /** True when any distance is an estimate, so the UI can say so once. */
  anyEstimated: boolean;
}

export async function roadDistancesForSearch(input: {
  options: ListingSearchOptions;
  profile: RouteProfile;
  signal?: AbortSignal;
}): Promise<RoadDistanceResult> {
  // The whole filtered candidate set, ids and coordinates only — deliberately
  // not the page. Sorting by total cost across pages requires comparing every
  // candidate, so this is the one place the query is run unpaged.
  const candidates = await listingsInRadius({
    office: input.options.office,
    radiusMeters: input.options.radiusMeters,
    filters: input.options.filters,
    statuses: input.options.statuses,
  });

  if (candidates.length === 0) {
    return { distances: [], anyEstimated: false };
  }

  const key = geoCacheKey(
    'table',
    input.profile,
    officeKey(input.options.office),
    candidateHash(candidates.map((candidate) => candidate.id)),
  );

  const cached = await cacheGet<RoadDistance[]>(key);
  if (cached) {
    return { distances: cached, anyEstimated: cached.some((entry) => entry.estimated) };
  }

  const matrix = await resolveRoutingProvider().table({
    from: input.options.office,
    to: candidates.map((candidate) => ({ lat: candidate.lat, lng: candidate.lng })),
    profile: input.profile,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const distances: RoadDistance[] = [];

  for (const [index, candidate] of candidates.entries()) {
    const meters = matrix?.distances[index];

    if (typeof meters === 'number') {
      distances.push({ listingId: candidate.id, meters, estimated: false });
      continue;
    }

    // A null cell, or no matrix at all. Estimated, never dropped.
    distances.push(await estimateFor(input.options.office, candidate));
  }

  const anyEstimated = distances.some((entry) => entry.estimated);

  if (!matrix) {
    logger.warn(
      { candidates: candidates.length, profile: input.profile },
      'no road distance matrix; every commute cost in this search is an estimate',
    );
  }

  // Epoch-prefixed and cached for as long as a route is: the matrix is derived
  // from the same graph, so a rebuild must strand it (D46). Paging through a
  // sorted result therefore measures once.
  await cacheSet(key, distances, CACHE_TTL_SECONDS.route);

  return { distances, anyEstimated };
}
