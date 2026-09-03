import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OverpassPoiProvider } from '../src/geo/overpass.js';
import { cacheSet } from '../src/lib/cache.js';
import { geoCacheKey } from '../src/geo/manifest.js';
import { closeRedis, redis } from '../src/lib/redis.js';

/**
 * The POI adapter's behaviour against a local instance (D48).
 *
 * Three states, and the difference between the last two is the whole point of
 * `degraded`: answered, could not refresh, and nothing here. A panel that says
 * "none nearby" because a service is importing is lying to someone choosing
 * where to live.
 *
 * Real Redis, because what is being tested is which cache key gets read and
 * written; the upstream is stubbed because what is NOT being tested is
 * Overpass. The live-service checks are in `geo-boundary.test.ts`.
 */
const provider = new OverpassPoiProvider();

/**
 * A coordinate no other test and no earlier run has used.
 *
 * Both halves matter, and the first version of this got it wrong: cache keys
 * round the coordinate to 4 decimals, so random jitter finer than 1e-4
 * collapses onto the same key and one test reads another's answer. The run
 * offset keeps runs apart; the sequence keeps tests within a run apart; and
 * both move in whole 1e-4 steps so neither can round into the other.
 */
const RUN_OFFSET = Number.parseInt(randomBytes(2).toString('hex'), 16) % 500;
let sequence = 0;

function coldCenter(): { lat: number; lng: number } {
  sequence += 1;
  const step = (RUN_OFFSET * 10 + sequence) / 10_000;
  return { lat: 12.9352 + step, lng: 77.6245 + step };
}

function poiResponse(count: number): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      elements: Array.from({ length: count }, (_, index) => ({
        type: 'node',
        id: index + 1,
        lat: 12.9355 + index / 10_000,
        lon: 77.6248,
        tags: { amenity: 'pharmacy', name: `Pharmacy ${String(index)}` },
      })),
    }),
  } as unknown as Response;
}

let redisReachable = false;

beforeAll(async () => {
  try {
    if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
    redisReachable = (await redis.ping()) === 'PONG';
  } catch {
    redisReachable = false;
  }
});

afterAll(async () => {
  await closeRedis();
});

describe('OverpassPoiProvider', () => {
  it('populates a cold read when the local instance answers quickly', async () => {
    expect(redisReachable, 'needs the compose Redis on REDIS_URL').toBe(true);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(poiResponse(3));

    const result = await provider.nearby({ center: coldCenter(), radiusMeters: 1500 });

    // Not degraded, not empty: against a service that answers in about a
    // second there is nothing to apologise for, and the old
    // answer-degraded-then-poll behaviour would have made a fast panel feel
    // slow for no reason.
    expect(result.degraded).toBe(false);
    expect(result.pois).toHaveLength(3);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
  });

  it('asks for quadtile ordering, which D42 measured as load-bearing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(poiResponse(1));

    await provider.nearby({ center: coldCenter(), radiusMeters: 1500 });

    const body = fetchSpy.mock.calls[0]?.[1]?.body;
    expect(String(body)).toContain('qt');

    fetchSpy.mockRestore();
  });

  it('degrades rather than holding the request open when the service is slow', async () => {
    expect(redisReachable).toBe(true);
    // Longer than OVERPASS_COLD_WAIT_MS: an importing or wedged Overpass must
    // not be able to hold a sidebar panel's request open.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(poiResponse(2)), 5_000).unref();
        }),
    );

    const center = coldCenter();
    const started = Date.now();
    const result = await provider.nearby({ center, radiusMeters: 1500 });
    const waited = Date.now() - started;

    expect(result.degraded).toBe(true);
    expect(result.pois).toHaveLength(0);
    expect(waited).toBeLessThan(4_500);

    // And the warm it started outlives the request, so the next viewer is
    // served the real answer rather than starting again.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const next = await provider.nearby({ center, radiusMeters: 1500 });
      if (!next.degraded) {
        expect(next.pois).toHaveLength(2);
        fetchSpy.mockRestore();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    fetchSpy.mockRestore();
    throw new Error('the background warm never landed');
  }, 20_000);

  it('serves the long-lived copy, marked degraded, when the service is down', async () => {
    expect(redisReachable).toBe(true);
    const center = coldCenter();
    const key = geoCacheKey(
      'poi',
      `${center.lat.toFixed(4)},${center.lng.toFixed(4)}`,
      1500,
      'all',
    );

    // What a previous day's successful warm would have left behind.
    await cacheSet(
      `${key}:stale`,
      {
        pois: [
          {
            id: 'node/1',
            category: 'hospital',
            name: 'Yesterday General',
            lat: center.lat,
            lng: center.lng,
            distanceMeters: 120,
          },
        ],
        degraded: false,
        fetchedAt: new Date(Date.now() - 86_400_000).toISOString(),
      },
      3600,
    );

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('connect ECONNREFUSED'));

    const result = await provider.nearby({ center, radiusMeters: 1500 });

    // Yesterday's hospitals with a note beat "none nearby", which would be
    // false. `degraded` is what lets the UI say which of the two it is.
    expect(result.degraded).toBe(true);
    expect(result.pois).toHaveLength(1);
    expect(result.pois[0]?.name).toBe('Yesterday General');

    fetchSpy.mockRestore();
  });
});
