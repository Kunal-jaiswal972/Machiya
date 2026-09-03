import {
  CACHE_TTL_SECONDS,
  type Coordinate,
  type RouteProfile,
  type RouteResult,
  type RoutingProvider,
} from '@machiya/shared';
import { z } from 'zod';
import { env } from '../env.js';
import { cached } from '../lib/cache.js';
import { geoCacheKey } from './manifest.js';
import { logger } from '../logger.js';

/**
 * Road distance and duration, from self-hosted OSRM.
 *
 * This is the number the commute-cost engine spends: straight-line distance is
 * for ring arithmetic only, and using it for cost would understate every
 * commute in a city with a river or a one-way system through it.
 *
 * Two OSRM instances, one per graph. `osrm-routed` **ignores the profile
 * segment in the URL** — the graph it was given decides the profile — so the
 * profile here selects the base URL, not a path segment. Getting that wrong
 * produces plausible car answers labelled as bike ones, which is worse than an
 * error.
 */
const osrmRouteSchema = z.object({
  code: z.string(),
  routes: z
    .array(
      z.object({
        distance: z.number(),
        duration: z.number(),
        geometry: z
          .object({
            type: z.literal('LineString'),
            coordinates: z.array(z.tuple([z.number(), z.number()])),
          })
          .optional(),
      }),
    )
    .default([]),
});

/** Rounded to ~11 m before it becomes a cache key; a metre does not change a route. */
function keyPart(coordinate: Coordinate): string {
  return `${coordinate.lat.toFixed(4)},${coordinate.lng.toFixed(4)}`;
}

export class OsrmRoutingProvider implements RoutingProvider {
  readonly name = 'osrm';

  private baseUrlFor(profile: RouteProfile): string {
    return profile === 'bike' ? env.OSRM_BIKE_URL : env.OSRM_CAR_URL;
  }

  async route(input: {
    from: Coordinate;
    to: Coordinate;
    profile: RouteProfile;
    signal?: AbortSignal;
  }): Promise<RouteResult | null> {
    const { from, to, profile } = input;
    // Epoch-prefixed: a route belongs to the graph that produced it, so a
    // rebuilt graph must not be able to serve the old geometry. See D46.
    const key = geoCacheKey('route', profile, keyPart(from), keyPart(to));

    try {
      const { value } = await cached<RouteResult | null>({
        key,
        ttlSeconds: CACHE_TTL_SECONDS.route,
        // A route between two fixed points does not change often, so a stale
        // copy is a much better answer than none while the graph is rebuilding.
        keepStaleFor: CACHE_TTL_SECONDS.route * 6,
        load: () => this.fetchRoute(from, to, profile, input.signal),
      });

      return value;
    } catch (error) {
      // The graph may not be built yet (`pnpm bootstrap` never run), or the
      // container may be down. Neither is worth failing a page for — the
      // caller falls back to straight-line distance and says so.
      logger.warn({ err: error, profile }, 'osrm route failed');
      return null;
    }
  }

  private async fetchRoute(
    from: Coordinate,
    to: Coordinate,
    profile: RouteProfile,
    signal?: AbortSignal,
  ): Promise<RouteResult | null> {
    const base = this.baseUrlFor(profile);
    // `driving` is literal, not a variable: osrm-routed ignores this segment
    // entirely and the graph decides. Writing `bike` here would imply a
    // distinction that does not exist. See docs/geo.md.
    const path = `/route/v1/driving/${String(from.lng)},${String(from.lat)};${String(to.lng)},${String(to.lat)}`;

    const url = new URL(path, base);
    url.searchParams.set('overview', 'simplified');
    url.searchParams.set('geometries', 'geojson');
    url.searchParams.set('alternatives', 'false');
    url.searchParams.set('steps', 'false');

    const response = await fetch(url, {
      // Both signals, for the reason in the Overpass provider: the caller's
      // signal alone would remove the ceiling.
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(6_000)]),
    });

    if (!response.ok) {
      throw new Error(`osrm ${String(response.status)} for ${profile}`);
    }

    const parsed = osrmRouteSchema.parse(await response.json());

    // `NoRoute` is a legitimate answer: an island, or a point the graph does not
    // reach. Null, not an error.
    if (parsed.code !== 'Ok' || parsed.routes.length === 0) return null;

    const best = parsed.routes[0];
    if (!best) return null;

    return {
      profile,
      distanceMeters: best.distance,
      durationSeconds: best.duration,
      geometry: best.geometry ?? null,
      degraded: false,
    };
  }
}

let provider: RoutingProvider | undefined;

export function resolveRoutingProvider(): RoutingProvider {
  provider ??= new OsrmRoutingProvider();
  return provider;
}

/**
 * A route when OSRM cannot give one.
 *
 * A straight line multiplied by a detour factor. **It is marked `degraded`**, so
 * the UI labels it an estimate rather than presenting it as measured fact —
 * showing an estimate as a measurement in a product whose whole argument is
 * "this is your real commute" would undermine the thing it is selling.
 *
 * 1.35 is the usual urban road-to-straight-line ratio; the speeds are
 * deliberately conservative for Indian city traffic.
 */
const DETOUR_FACTOR = 1.35;
const SPEEDS_KMH: Record<RouteProfile, number> = { car: 22, bike: 18 };

export function estimateRoute(input: {
  straightLineMeters: number;
  profile: RouteProfile;
}): RouteResult {
  const distanceMeters = input.straightLineMeters * DETOUR_FACTOR;
  const speed = SPEEDS_KMH[input.profile];

  return {
    profile: input.profile,
    distanceMeters,
    durationSeconds: (distanceMeters / 1000 / speed) * 3600,
    geometry: null,
    degraded: true,
  };
}
