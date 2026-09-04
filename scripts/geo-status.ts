/**
 * What is stale, and the exact command that rebuilds each thing.
 *
 *   pnpm geo:status
 *
 * The failure this exists for: a city added to the config while the artifacts
 * still describe the old list. Everything reports healthy, and the new city
 * geocodes and routes to nowhere. So each artifact is compared against what the
 * running config says it should be, and anything stale is printed with its fix
 * rather than with advice to "rebuild". Exits non-zero when anything is stale,
 * so it can gate a script. See DECISIONS.md D51.
 *
 * Three kinds of staleness, detected three different ways:
 *
 *  - **files on disk** (city cuts, merged extract) — compared against the
 *    config's padded bboxes and the manifest's checksums;
 *  - **the OSRM graphs** — each graph directory holds the sha256 of the extract
 *    it was built from, read out of the named volume through a throwaway
 *    container;
 *  - **the Nominatim and Overpass imports** — each writes a stamp file when
 *    bootstrap confirms it answering, because neither service can be asked
 *    which extract it imported.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CITIES, computeGeoConfigHash, geoManifestSchema } from '@machiya/shared/cities';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(REPO_ROOT, '.osm-cache');
const OUT_DIR = join(REPO_ROOT, 'osm-data');
const MERGED = join(OUT_DIR, 'merged.osm.pbf');

/** Written by bootstrap once a service is confirmed answering. */
export function importStampPath(service: string): string {
  return join(OUT_DIR, `.imported-${service}`);
}

type State = 'ok' | 'stale' | 'missing' | 'unknown';

interface Row {
  artifact: string;
  state: State;
  detail: string;
  fix: string;
}

const REBUILD = 'pnpm bootstrap';

function sha256File(path: string): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

/**
 * Reads a file out of a named docker volume.
 *
 * A throwaway `busybox` container is the only way to look inside one from the
 * host, and it is also the only way that works identically on Linux, macOS and
 * Windows. Returns null when docker is unavailable — a status report must not
 * fail because the daemon is down.
 */
function readFromVolume(volume: string, path: string): string | null {
  try {
    return execFileSync(
      'docker',
      ['run', '--rm', '-v', `${volume}:/v:ro`, 'busybox:1.37', 'cat', `/v${path}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return null;
  }
}

function cutRows(): Row[] {
  return CITIES.map((city): Row => {
    const cut = join(CACHE_DIR, `${city.slug}.osm.pbf`);
    const stamp = join(CACHE_DIR, `${city.slug}.bbox`);
    const want = [
      city.paddedBbox.minLng,
      city.paddedBbox.minLat,
      city.paddedBbox.maxLng,
      city.paddedBbox.maxLat,
    ].join(',');

    if (!existsSync(cut)) {
      return {
        artifact: `cut: ${city.slug}`,
        state: 'missing',
        detail: 'never cut',
        fix: REBUILD,
      };
    }
    if (!existsSync(stamp)) {
      return {
        artifact: `cut: ${city.slug}`,
        state: 'unknown',
        detail: 'no bounds stamp — cut before stamping existed',
        fix: REBUILD,
      };
    }

    const have = readFileSync(stamp, 'utf8').trim();
    return have === want
      ? { artifact: `cut: ${city.slug}`, state: 'ok', detail: want, fix: '' }
      : {
          artifact: `cut: ${city.slug}`,
          state: 'stale',
          detail: `cut at ${have}, config says ${want}`,
          fix: REBUILD,
        };
  });
}

function manifestRows(): { rows: Row[]; mergedSha: string | null } {
  const path = join(OUT_DIR, 'manifest.json');

  if (!existsSync(path)) {
    return {
      rows: [
        {
          artifact: 'manifest',
          state: 'missing',
          detail: 'no osm-data/manifest.json — derived caches use the "unbuilt" epoch',
          fix: REBUILD,
        },
      ],
      mergedSha: null,
    };
  }

  const parsed = geoManifestSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    return {
      rows: [
        {
          artifact: 'manifest',
          state: 'stale',
          detail: `unreadable: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
          fix: 'pnpm geo:manifest',
        },
      ],
      mergedSha: null,
    };
  }

  const manifest = parsed.data;
  const configHash = computeGeoConfigHash(CITIES);
  const rows: Row[] = [];

  rows.push(
    configHash === manifest.configHash
      ? {
          artifact: 'manifest',
          state: 'ok',
          detail: `epoch ${manifest.epoch}, ${manifest.downloadStrategy}, ${String(manifest.cities.length)} cities`,
          fix: '',
        }
      : {
          artifact: 'manifest',
          state: 'stale',
          detail: `config hash ${configHash} but manifest says ${manifest.configHash} — the artifacts predate the running city config`,
          fix: REBUILD,
        },
  );

  const configured = new Set(CITIES.map((city) => city.slug));
  const described = new Set(manifest.cities.map((city) => city.slug));
  const added = [...configured].filter((slug) => !described.has(slug));
  const removed = [...described].filter((slug) => !configured.has(slug));

  if (added.length > 0 || removed.length > 0) {
    rows.push({
      artifact: 'city list',
      state: 'stale',
      detail: [
        added.length > 0 ? `added: ${added.join(', ')}` : '',
        removed.length > 0 ? `removed: ${removed.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; '),
      fix: REBUILD,
    });
  }

  if (!existsSync(MERGED)) {
    rows.push({
      artifact: 'merged extract',
      state: 'missing',
      detail: 'osm-data/merged.osm.pbf is absent',
      fix: REBUILD,
    });
    return { rows, mergedSha: null };
  }

  const mergedSha = sha256File(MERGED);
  rows.push(
    mergedSha === manifest.merged.sha256
      ? { artifact: 'merged extract', state: 'ok', detail: `${mergedSha.slice(0, 12)}…`, fix: '' }
      : {
          artifact: 'merged extract',
          state: 'stale',
          detail: 'on disk does not match the manifest',
          fix: 'pnpm geo:manifest',
        },
  );

  return { rows, mergedSha };
}

function osrmRows(mergedSha: string | null): Row[] {
  return (['car', 'bicycle'] as const).map((profile): Row => {
    const stored = readFromVolume('machiya_osrm-data', `/${profile}/source.sha256`);

    if (stored === null) {
      return {
        artifact: `osrm ${profile} graph`,
        state: 'unknown',
        detail: 'not built, or docker unavailable',
        fix: REBUILD,
      };
    }
    if (mergedSha === null) {
      return {
        artifact: `osrm ${profile} graph`,
        state: 'unknown',
        detail: 'nothing to compare against',
        fix: REBUILD,
      };
    }

    return stored === mergedSha
      ? {
          artifact: `osrm ${profile} graph`,
          state: 'ok',
          detail: 'built from this extract',
          fix: '',
        }
      : {
          artifact: `osrm ${profile} graph`,
          state: 'stale',
          detail: 'built from a different extract',
          fix: REBUILD,
        };
  });
}

/**
 * Nominatim and Overpass import on first boot only, so re-importing means
 * dropping the volume. Neither can be asked which extract it holds, hence the
 * stamp — and hence the fix being three commands rather than one.
 */
function importRows(mergedSha: string | null): Row[] {
  const services = [
    { service: 'nominatim', volume: 'machiya_nominatim-data' },
    { service: 'overpass', volume: 'machiya_overpass-db' },
  ];

  return services.map(({ service, volume }): Row => {
    const fix = `docker compose --profile geo rm -sf ${service} && docker volume rm ${volume} && ${REBUILD}`;
    const stamp = importStampPath(service);

    if (!existsSync(stamp)) {
      return {
        artifact: `${service} import`,
        state: 'unknown',
        detail: 'no import stamp — imported before stamping existed, or never imported',
        fix,
      };
    }

    const stamped = readFileSync(stamp, 'utf8').trim();
    if (mergedSha === null) {
      return { artifact: `${service} import`, state: 'unknown', detail: 'nothing to compare', fix };
    }

    return stamped === mergedSha
      ? { artifact: `${service} import`, state: 'ok', detail: 'imported this extract', fix: '' }
      : {
          artifact: `${service} import`,
          state: 'stale',
          detail: 'imported a different extract',
          fix,
        };
  });
}

export function geoStatus(): Row[] {
  const { rows: manifestPart, mergedSha } = manifestRows();
  return [...manifestPart, ...cutRows(), ...osrmRows(mergedSha), ...importRows(mergedSha)];
}

function main(): void {
  const rows = geoStatus();
  const width = Math.max(...rows.map((row) => row.artifact.length));

  console.log('OSM artifact status');
  console.log('');
  for (const row of rows) {
    console.log(`  ${row.artifact.padEnd(width)}  ${row.state.padEnd(7)} ${row.detail}`);
  }

  const needsWork = rows.filter((row) => row.state !== 'ok');
  if (needsWork.length === 0) {
    console.log('');
    console.log('Everything matches the running city config.');
    return;
  }

  console.log('');
  console.log('To fix:');
  for (const fix of new Set(needsWork.map((row) => row.fix).filter(Boolean))) {
    console.log(`  ${fix}`);
  }

  // Non-zero, so this can gate a script. `unknown` counts: an artifact nobody
  // can vouch for is not one to build on.
  process.exitCode = 1;
}

if (process.argv[1] && basename(process.argv[1]) === 'geo-status.ts') {
  main();
}
