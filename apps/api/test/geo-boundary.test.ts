import { describe, expect, it } from 'vitest';
import { env } from '../src/env.js';

/**
 * The padded cuts, against the real services.
 *
 * These are the tests that would have caught the unpadded cut, and they cannot
 * be written against a mock: what broke was the **extract**, so only a live
 * OSRM graph and a live Overpass database can say whether it is fixed. Both
 * come from the `geo` compose profile, so each suite skips itself — loudly,
 * naming the command that fixes it — when its service is not up. See
 * DECISIONS.md D47.
 *
 * Every coordinate pair below straddles a boundary the OLD unpadded boxes had,
 * so each assertion is about geometry that used to be missing entirely.
 */
/**
 * The old box's northern edge, and the POI probe sits on it.
 *
 * Not the eastern edge: the first version of this test probed 77.78 and found
 * two POIs, because that stretch towards Hoskote is genuinely empty in OSM. A
 * test that cannot tell "we cut the map here" from "nothing is here" proves
 * nothing, so the probe moved to an edge with real density on both sides —
 * Jakkur/Singanayakanahalli, where 39 places sit within 1.5 km and 9 of them
 * are north of the old cut.
 */
const OLD_BENGALURU_MAX_LAT = 13.14;
const POI_PROBE = { lat: OLD_BENGALURU_MAX_LAT, lng: 77.57 };

/** Inside the old box (its eastern edge was 77.78), in Whitefield. */
const INSIDE = { lat: 12.9698, lng: 77.77 };
/** Outside the old box, inside the padded one: towards Hoskote. */
const OUTSIDE = { lat: 12.9698, lng: 77.83 };

function straightLineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

async function reachable(url: string, init?: RequestInit): Promise<boolean> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}

const FIX = 'pnpm bootstrap && docker compose --profile geo up -d';

const osrmUp = await reachable(
  new URL('/route/v1/driving/77.77,12.9698;77.78,12.9698?overview=false', env.OSRM_CAR_URL).href,
);
const overpassUp = await reachable(env.OVERPASS_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
  body: new URLSearchParams({ data: '[out:json][timeout:10];out count;' }),
});

if (!osrmUp) console.warn(`geo-boundary: OSRM is not answering — skipping. Fix: ${FIX}`);
if (!overpassUp) console.warn(`geo-boundary: Overpass is not answering — skipping. Fix: ${FIX}`);

describe.skipIf(!osrmUp)('routing across a former cut edge', () => {
  it('finds a real road route between points the old box split', async () => {
    const { OsrmRoutingProvider } = await import('../src/geo/osrm.js');
    const route = await new OsrmRoutingProvider().route({
      from: INSIDE,
      to: OUTSIDE,
      profile: 'car',
    });

    expect(route, 'no route: the graph probably still ends at the old cut edge').not.toBeNull();
    expect(route?.degraded).toBe(false);

    const straight = straightLineKm(INSIDE, OUTSIDE);
    const roadKm = (route?.distanceMeters ?? 0) / 1000;

    // Longer than the straight line, and not absurdly longer. An absurd detour
    // is the other unpadded-cut symptom: the graph goes the long way round
    // because the direct road left the box.
    expect(roadKm).toBeGreaterThan(straight * 0.95);
    expect(roadKm).toBeLessThan(straight * 2.5);
    expect(route?.geometry?.coordinates.length ?? 0).toBeGreaterThan(2);
  });
});

describe.skipIf(!overpassUp)('POIs near a former cut edge', () => {
  it('returns places on BOTH sides of the old boundary', async () => {
    const { OverpassPoiProvider } = await import('../src/geo/overpass.js');
    const provider = new OverpassPoiProvider();
    const center = POI_PROBE;

    // The provider answers degraded-and-empty on a cold key and warms in the
    // background (D42), so poll for the warm rather than asserting on the
    // first read.
    let result = await provider.nearby({ center, radiusMeters: 1500 });
    for (let attempt = 0; attempt < 80 && result.degraded; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      result = await provider.nearby({ center, radiusMeters: 1500 });
    }

    expect(result.degraded, 'the background Overpass warm never completed').toBe(false);

    // A count alone is a weak assertion — a truncated half-circle still has
    // places in it. What proves the cut is padded is places on the far side
    // of the old edge, which by definition did not exist in the old extract.
    const beyond = result.pois.filter((poi) => poi.lat > OLD_BENGALURU_MAX_LAT);

    expect(result.pois.length).toBeGreaterThan(3);
    expect(
      beyond.length,
      'no POIs north of the old cut edge — the extract is still truncated',
    ).toBeGreaterThan(0);
  }, 60_000);
});
