import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GEO_MANIFEST_VERSION, type GeoManifest } from '@machiya/shared/cities';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The geo epoch, against real Redis.
 *
 * What needs proving is not that a hash function hashes: it is that changing
 * the epoch makes an already-cached route and an already-cached POI set
 * **unreachable**, so a rebuild cannot serve geometry derived from bounds that
 * no longer exist. A mocked cache would prove nothing about that, since the
 * whole mechanism is the key string. So this talks to the Redis the rest of the
 * stack uses, and every run picks a random epoch pair so it starts cold.
 */
const scratch = mkdtempSync(join(tmpdir(), 'machiya-epoch-'));
const closers: (() => Promise<void>)[] = [];

function manifestWithEpoch(epoch: string): GeoManifest {
  return {
    version: GEO_MANIFEST_VERSION,
    epoch,
    configHash: 'testconfig',
    generatedAt: new Date().toISOString(),
    cities: [
      {
        slug: 'patna',
        zone: 'eastern-zone',
        bbox: { minLng: 84, minLat: 25, maxLng: 86, maxLat: 26 },
      },
    ],
    sources: [{ name: 'eastern-zone-latest.osm.pbf', bytes: 1, sha256: 'a'.repeat(64) }],
    merged: { name: 'merged.osm.pbf', bytes: 1, sha256: 'b'.repeat(64) },
  };
}

/**
 * Loads the geo modules against a manifest carrying `epoch`.
 *
 * `resetModules` is what makes this work: the epoch is read once at import time
 * on purpose (an epoch that changed under a running process would split a
 * request's reads from its writes), so the only way to change it is a fresh
 * module graph — which is also exactly what a redeploy after a rebuild does.
 */
async function loadAt(epoch: string) {
  writeFileSync(join(scratch, `${epoch}.json`), JSON.stringify(manifestWithEpoch(epoch)), 'utf8');
  process.env.GEO_MANIFEST_PATH = join(scratch, `${epoch}.json`);

  vi.resetModules();

  const [{ OsrmRoutingProvider }, { OverpassPoiProvider }, { geoEpoch }, redis] = await Promise.all(
    [
      import('../src/geo/osrm.js'),
      import('../src/geo/overpass.js'),
      import('../src/geo/manifest.js'),
      import('../src/lib/redis.js'),
    ],
  );

  closers.push(redis.closeRedis);

  return {
    epoch: geoEpoch(),
    routing: new OsrmRoutingProvider(),
    pois: new OverpassPoiProvider(),
  };
}

const OFFICE = { lat: 25.6127, lng: 85.1145 };
const LISTING = { lat: 25.5941, lng: 85.1376 };

function osrmResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      code: 'Ok',
      routes: [
        {
          distance: 4321,
          duration: 900,
          geometry: { type: 'LineString', coordinates: [[85.1145, 25.6127]] },
        },
      ],
    }),
  } as unknown as Response;
}

function overpassResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      elements: [
        {
          type: 'node',
          id: 1,
          lat: 25.5945,
          lon: 85.138,
          tags: { amenity: 'hospital', name: 'A' },
        },
      ],
    }),
  } as unknown as Response;
}

/** The warm is deliberately not awaited, so poll for the cache write. */
async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const epochA = `ta${randomBytes(4).toString('hex')}`;
const epochB = `tb${randomBytes(4).toString('hex')}`;

let redisReachable = false;

beforeAll(async () => {
  const { redis } = await import('../src/lib/redis.js');
  try {
    if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
    redisReachable = (await redis.ping()) === 'PONG';
  } catch {
    redisReachable = false;
  }
  closers.push((await import('../src/lib/redis.js')).closeRedis);
});

afterAll(async () => {
  for (const close of closers) await close();
});

describe('the geo epoch scopes derived cache entries', () => {
  it('is read from the manifest, not invented', async () => {
    const loaded = await loadAt(epochA);
    expect(loaded.epoch).toBe(epochA);
  });

  it('falls back to "unbuilt" — never to a plausible-looking epoch — with no manifest', async () => {
    process.env.GEO_MANIFEST_PATH = join(scratch, 'does-not-exist.json');
    vi.resetModules();
    const { geoEpoch } = await import('../src/geo/manifest.js');
    expect(geoEpoch()).toBe('unbuilt');
  });

  it('makes a cached route miss after the epoch changes', async () => {
    expect(redisReachable, 'this test needs the compose Redis on REDIS_URL').toBe(true);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(osrmResponse());

    const first = await loadAt(epochA);
    const routeA = await first.routing.route({ from: OFFICE, to: LISTING, profile: 'car' });
    expect(routeA?.distanceMeters).toBe(4321);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Same epoch, same points: served from Redis, no second upstream call.
    await first.routing.route({ from: OFFICE, to: LISTING, profile: 'car' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // A rebuild. The old entry still exists in Redis under the old prefix and
    // is now unreachable, so the route is re-derived rather than served.
    const second = await loadAt(epochB);
    const routeB = await second.routing.route({ from: OFFICE, to: LISTING, profile: 'car' });
    expect(routeB?.distanceMeters).toBe(4321);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    fetchSpy.mockRestore();
  });

  it('makes a cached POI set miss after the epoch changes', async () => {
    expect(redisReachable, 'this test needs the compose Redis on REDIS_URL').toBe(true);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(overpassResponse());

    const first = await loadAt(epochA);
    // A cold read never blocks: it answers degraded and warms in the background.
    const cold = await first.pois.nearby({ center: LISTING, radiusMeters: 1500 });
    expect(cold.degraded).toBe(true);
    expect(cold.pois).toHaveLength(0);

    await waitFor(async () => {
      const warmed = await first.pois.nearby({ center: LISTING, radiusMeters: 1500 });
      return !warmed.degraded && warmed.pois.length === 1;
    }, 'the background Overpass warm');

    const callsAfterWarm = fetchSpy.mock.calls.length;

    const second = await loadAt(epochB);
    const afterRebuild = await second.pois.nearby({ center: LISTING, radiusMeters: 1500 });
    // Not the previous epoch's answer — including not its `:stale` copy, which
    // is prefixed too. It re-derives from scratch.
    expect(afterRebuild.degraded).toBe(true);
    expect(afterRebuild.pois).toHaveLength(0);

    await waitFor(async () => {
      const warmed = await second.pois.nearby({ center: LISTING, radiusMeters: 1500 });
      return !warmed.degraded && warmed.pois.length === 1;
    }, 'the background Overpass warm under the new epoch');

    expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsAfterWarm);

    fetchSpy.mockRestore();
  });
});
