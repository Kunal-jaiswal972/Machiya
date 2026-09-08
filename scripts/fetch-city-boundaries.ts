/**
 * Derives each city's administrative boundary from the **local** Nominatim and
 * writes `packages/shared/src/cities/boundaries.generated.ts`.
 *
 *   pnpm cities:boundaries
 *
 * Run once per city, with the `geo` profile up. The output is committed, so
 * seeding needs no live service and every machine gets identical geometry —
 * the same split as the seed photographs (D31): a live derivation step, and a
 * committed artifact that is the actual source of truth.
 *
 * Why Nominatim rather than `osmium` extracting the `admin_level=8` relation
 * during bootstrap: it is far less code and it reuses a service we now run
 * locally anyway, which also means re-deriving costs nothing. Reasoning and the
 * per-city results: DECISIONS.md D50.
 *
 * The polygons are simplified before being written. A raw OSM city boundary is
 * thousands of points, and this is used for one thing — `ST_Covers(boundary,
 * listing.location)` — where metre-level fidelity buys nothing and a megabyte
 * of committed coordinates costs review, memory and diff noise.
 */
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CITIES } from '@machiya/shared/cities';
import { z } from 'zod';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(REPO_ROOT, 'packages', 'shared', 'src', 'cities', 'boundaries.generated.ts');

const NOMINATIM_URL = process.env.NOMINATIM_URL ?? 'http://localhost:7070';
// GEO_USER_AGENT with the old NOMINATIM_USER_AGENT still honoured, matching the
// API's own alias (D87): this script talks to the same Nominatim.
const USER_AGENT =
  process.env.GEO_USER_AGENT ??
  process.env.NOMINATIM_USER_AGENT ??
  'MachiyaBot/0.1 (+https://github.com/Kunal-jaiswal972/Machiya; geocoding and POI lookups)';

/**
 * Simplification tolerance in degrees. ~0.0005° is roughly 50 m at these
 * latitudes: well inside the precision a city boundary is mapped to, and far
 * finer than the question being asked of it.
 */
const TOLERANCE_DEGREES = 0.0005;

const geometrySchema = z.union([
  z.object({
    type: z.literal('Polygon'),
    coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
  }),
  z.object({
    type: z.literal('MultiPolygon'),
    coordinates: z.array(z.array(z.array(z.tuple([z.number(), z.number()])))),
  }),
]);

type Geometry = z.infer<typeof geometrySchema>;

const searchResultSchema = z.object({
  osm_type: z.string().optional(),
  osm_id: z.number().optional(),
  display_name: z.string().optional(),
  addresstype: z.string().optional(),
  // Deliberately UNKNOWN rather than the geometry union: Nominatim returns a
  // Point for plenty of places, and a strict union here fails the parse of the
  // WHOLE result array because one row is not a polygon. Narrowed per row.
  geojson: z.unknown().optional(),
});

type Ring = [number, number][];

/**
 * Douglas-Peucker, written out rather than pulled in.
 *
 * One function, no dependency, against a build step that runs once per city per
 * rebuild. Perpendicular distance is computed in raw degrees, which is
 * anisotropic away from the equator — acceptable because the tolerance is an
 * order of magnitude finer than the feature, and the only consumer is a
 * containment test.
 */
function simplifyRing(ring: Ring, tolerance: number): Ring {
  if (ring.length <= 4) return ring;

  const keep = new Set<number>([0, ring.length - 1]);
  const stack: [number, number][] = [[0, ring.length - 1]];

  const perpendicular = (index: number, startIndex: number, endIndex: number): number => {
    const point = ring[index];
    const start = ring[startIndex];
    const end = ring[endIndex];
    if (!point || !start || !end) return 0;

    const [x, y] = point;
    const [x1, y1] = start;
    const [x2, y2] = end;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared === 0) return Math.hypot(x - x1, y - y1);

    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
    return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
  };

  while (stack.length > 0) {
    const segment = stack.pop();
    if (!segment) break;
    const [start, end] = segment;

    let worst = -1;
    let worstDistance = 0;

    for (let index = start + 1; index < end; index += 1) {
      const distance = perpendicular(index, start, end);
      if (distance > worstDistance) {
        worstDistance = distance;
        worst = index;
      }
    }

    if (worst !== -1 && worstDistance > tolerance) {
      keep.add(worst);
      stack.push([start, worst], [worst, end]);
    }
  }

  const simplified = [...keep]
    .sort((a, b) => a - b)
    .map((index) => ring[index])
    .filter((point): point is [number, number] => Boolean(point));

  // A ring must stay closed and have at least four points, or PostGIS rejects
  // it. Rather than repair a degenerate ring, hand back the original.
  return simplified.length >= 4 ? simplified : ring;
}

function polygonsOf(geometry: Geometry): [number, number][][][] {
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
}

function countPoints(geometry: Geometry): number {
  return polygonsOf(geometry).reduce(
    (total, polygon) => total + polygon.reduce((sum, ring) => sum + ring.length, 0),
    0,
  );
}

function simplifyGeometry(geometry: Geometry): Geometry {
  return geometry.type === 'Polygon'
    ? {
        type: 'Polygon',
        coordinates: geometry.coordinates.map((ring) => simplifyRing(ring, TOLERANCE_DEGREES)),
      }
    : {
        type: 'MultiPolygon',
        coordinates: geometry.coordinates.map((polygon) =>
          polygon.map((ring) => simplifyRing(ring, TOLERANCE_DEGREES)),
        ),
      };
}

/** Ray casting. The only geometry predicate this script needs. */
function ringContains(ring: Ring, point: { lat: number; lng: number }): boolean {
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;

    const [xi, yi] = a;
    const [xj, yj] = b;
    if (yi > point.lat === yj > point.lat) continue;

    const crossing = ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (point.lng < crossing) inside = !inside;
  }

  return inside;
}

function geometryContains(geometry: Geometry, point: { lat: number; lng: number }): boolean {
  // Outer ring only. A centroid inside a hole is a pathological case for a city
  // boundary and not worth the code.
  return polygonsOf(geometry).some((polygon) => {
    const outer = polygon[0];
    return outer ? ringContains(outer, point) : false;
  });
}

interface Bounds {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

function boundsOf(geometry: Geometry): Bounds {
  let minLng = 180;
  let minLat = 90;
  let maxLng = -180;
  let maxLat = -90;

  for (const polygon of polygonsOf(geometry)) {
    for (const ring of polygon) {
      for (const [lng, lat] of ring) {
        minLng = Math.min(minLng, lng);
        minLat = Math.min(minLat, lat);
        maxLng = Math.max(maxLng, lng);
        maxLat = Math.max(maxLat, lat);
      }
    }
  }

  return { minLng, minLat, maxLng, maxLat };
}

const span = (box: Bounds): number => (box.maxLng - box.minLng) * (box.maxLat - box.minLat);

/**
 * Whether a candidate polygon is plausibly this city.
 *
 * Both checks earned their place on the first real run. Searching this
 * Nominatim for "Pune, Maharashtra" returned, in order: a housing society, four
 * buildings and a shop — every one a valid Polygon, and the first version of
 * this script wrote the housing society as Pune's boundary. Seven points.
 *
 * So a candidate has to CONTAIN the configured centroid and cover at least a
 * quarter of the configured bbox. Too large is deliberately allowed: some
 * cities are mapped only as a node here, with the enclosing subdistrict
 * carrying the polygon, and a slightly generous boundary still answers "which
 * city is this listing in" correctly — where the alternative is a guess.
 */
function isPlausible(
  geometry: Geometry,
  city: (typeof CITIES)[number],
): {
  ok: boolean;
  reason: string;
} {
  if (!geometryContains(geometry, city.centroid)) {
    return { ok: false, reason: 'does not contain the configured centroid' };
  }

  const ratio = span(boundsOf(geometry)) / span(city.bbox);
  return ratio < 0.25
    ? { ok: false, reason: `covers only ${(ratio * 100).toFixed(1)}% of the configured bbox` }
    : { ok: true, reason: `${(ratio * 100).toFixed(0)}% of the configured bbox` };
}

interface Candidate {
  geometry: Geometry;
  osmId: string;
  displayName: string;
}

interface Derived extends Candidate {
  slug: string;
  before: number;
  after: number;
  strategy: string;
}

async function askNominatim(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(path, NOMINATIM_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) throw new Error(`nominatim ${String(response.status)} for ${url.pathname}`);
  return response.json();
}

/** `/search` answers with an array, `/reverse` with a single object. */
function toCandidates(payload: unknown): Candidate[] {
  const many = z.array(searchResultSchema).safeParse(payload);
  const one = many.success ? null : searchResultSchema.safeParse(payload);
  const rows = many.success ? many.data : one?.success ? [one.data] : [];

  return rows.flatMap((row) => {
    const geometry = geometrySchema.safeParse(row.geojson);
    if (!geometry.success) return [];

    return [
      {
        geometry: geometry.data,
        osmId: `${row.osm_type ?? '?'}/${String(row.osm_id ?? 0)}`,
        displayName: row.display_name ?? '',
      },
    ];
  });
}

/**
 * Asks Nominatim for one city's boundary, three ways, and takes the first
 * plausible answer.
 *
 * The order is deliberate: the settlement search is the most specific, the
 * named search is the widest net, and the reverse lookup at the centroid with
 * `zoom=8` asks for the enclosing ADMINISTRATIVE area rather than the address
 * at the point — which is the one that works when a city is mapped only as a
 * node in this extract. That is the case for Pune here: the city itself has no
 * polygon at all and the enclosing subdistrict relation does.
 */
async function fetchBoundary(city: (typeof CITIES)[number]): Promise<Derived | null> {
  const attempts: { strategy: string; params: [string, Record<string, string>] }[] = [
    [
      'search:settlement',
      [
        '/search',
        {
          q: city.name,
          format: 'jsonv2',
          polygon_geojson: '1',
          limit: '5',
          featureType: 'settlement',
        },
      ],
    ],
    [
      'search:name-state',
      [
        '/search',
        {
          q: `${city.name}, ${city.state}`,
          format: 'jsonv2',
          polygon_geojson: '1',
          limit: '10',
        },
      ],
    ],
    [
      'reverse:admin',
      [
        '/reverse',
        {
          lat: String(city.centroid.lat),
          lon: String(city.centroid.lng),
          format: 'jsonv2',
          polygon_geojson: '1',
          zoom: '8',
        },
      ],
    ],
  ].map(([strategy, params]) => ({
    strategy: strategy as string,
    params: params as [string, Record<string, string>],
  }));

  for (const attempt of attempts) {
    let candidates: Candidate[] = [];

    try {
      candidates = toCandidates(await askNominatim(...attempt.params));
    } catch (error) {
      console.error(`  ${city.slug}: ${attempt.strategy} failed: ${String(error)}`);
      continue;
    }

    for (const candidate of candidates) {
      const verdict = isPlausible(candidate.geometry, city);

      if (!verdict.ok) {
        console.error(
          `  ${city.slug}: rejected ${candidate.osmId} from ${attempt.strategy} — ${verdict.reason}`,
        );
        continue;
      }

      const before = countPoints(candidate.geometry);
      const geometry = simplifyGeometry(candidate.geometry);

      return {
        ...candidate,
        slug: city.slug,
        geometry,
        before,
        after: countPoints(geometry),
        displayName: candidate.displayName || city.name,
        strategy: `${attempt.strategy}, ${verdict.reason}`,
      };
    }
  }

  return null;
}

const HEADER = `/**
 * GENERATED — do not edit by hand. Run \`pnpm cities:boundaries\`.
 *
 * City administrative boundaries, queried once from the **local** Nominatim
 * with \`polygon_geojson=1\` and simplified, then committed so that seeding
 * needs no live service and produces the same geometry on every machine. Rings
 * are \`[lng, lat]\`, GeoJSON order.
 *
 * A city with no entry here gets \`boundary: null\`, and city assignment falls
 * back to nearest centroid with a logged warning (D50).
 */

export interface CityBoundary {
  /** GeoJSON type, so this can be handed straight to \`ST_GeomFromGeoJSON\`. */
  type: 'Polygon' | 'MultiPolygon';
  /** Polygon: ring[point[lng,lat]]. MultiPolygon: polygon[ring[point]]. */
  coordinates: number[][][] | number[][][][];
  /** The place Nominatim matched, so a wrong one is visible in review. */
  source: string;
  /** The OSM object behind it, so a re-derivation can be compared. */
  osmId: string;
  /** Which lookup found it, and how it was judged plausible. */
  strategy: string;
  /** [pointsAfterSimplification, pointsBefore]. */
  points: number[];
}
`;

function render(derived: Derived[]): string {
  const entries = derived
    .map((item) =>
      [
        `  ${JSON.stringify(item.slug)}: {`,
        `    type: ${JSON.stringify(item.geometry.type)},`,
        `    source: ${JSON.stringify(item.displayName)},`,
        `    osmId: ${JSON.stringify(item.osmId)},`,
        `    strategy: ${JSON.stringify(item.strategy)},`,
        `    points: [${String(item.after)}, ${String(item.before)}],`,
        `    coordinates: ${JSON.stringify(item.geometry.coordinates)},`,
        '  },',
      ].join('\n'),
    )
    .join('\n');

  return `${HEADER}
export const CITY_BOUNDARIES: Record<string, CityBoundary> = {
${entries}
};
`;
}

async function main(): Promise<void> {
  console.log(`Deriving city boundaries from ${NOMINATIM_URL}`);

  const derived: Derived[] = [];
  const failed: string[] = [];

  for (const city of CITIES) {
    const result = await fetchBoundary(city);

    if (!result) {
      failed.push(city.slug);
      continue;
    }

    derived.push(result);
    console.log(
      `  ${city.slug}: ${result.geometry.type}, ${String(result.before)} -> ${String(
        result.after,
      )} points (${result.osmId}; ${result.strategy})`,
    );
  }

  if (derived.length === 0) {
    console.error(
      'No boundaries derived. Is the geo profile up? docker compose --profile geo up -d',
    );
    process.exit(1);
  }

  await writeFile(OUTPUT, render(derived), 'utf8');
  console.log('');
  console.log(`Wrote ${OUTPUT}`);
  console.log('Commit it: the seed reads this file, not Nominatim.');

  if (failed.length > 0) {
    // Not fatal to the file that was written: a city with no boundary still
    // works through the nearest-centroid fallback, and the validator warns
    // about it. But it is never silent.
    console.error('');
    console.error(
      `No boundary for: ${failed.join(', ')}. Those cities fall back to nearest-centroid assignment.`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'fetch-city-boundaries.ts') {
  await main();
}
