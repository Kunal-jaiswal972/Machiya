/**
 * Writes `osm-data/manifest.json` — the record of which OSM artifacts are on
 * this machine, and the geo epoch every derived cache key is prefixed with.
 *
 * Run by `scripts/bootstrap.sh` as its last step, and safe to run again on its
 * own: it only reads files and writes one JSON document.
 *
 *   pnpm tsx scripts/geo-manifest.ts write   # (re)write the manifest
 *   pnpm tsx scripts/geo-manifest.ts print   # show it, or say it is missing
 *   pnpm tsx scripts/geo-manifest.ts epoch   # print just the epoch
 *
 * Why an epoch at all: routes, POIs and geocodes are all derived from these
 * artifacts, so a cached entry is only valid for the artifacts that produced
 * it. Prefixing the keys with a hash of the inputs means a rebuild strands the
 * old entries instead of serving them, with nobody having to remember to flush
 * Redis. Reasoning in DECISIONS.md D46; the hash itself lives in
 * `@machiya/shared/cities` so the writer here and the reader in the API cannot
 * disagree about it.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GEO_MANIFEST_VERSION,
  computeGeoConfigHash,
  computeGeoEpoch,
  geoManifestSchema,
  type GeoManifest,
  type GeoSource,
  CITIES,
  planDownloads,
} from '@machiya/shared/cities';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(REPO_ROOT, '.osm-cache');
const OUT_DIR = join(REPO_ROOT, 'osm-data');
export const MANIFEST_PATH = join(OUT_DIR, 'manifest.json');

/**
 * Streamed rather than read into a buffer: the zone extracts are 200-550 MB
 * each and `readFile` on all of them at once is a needless gigabyte of RSS.
 */
async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);

  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }

  return hash.digest('hex');
}

async function describe(path: string): Promise<GeoSource> {
  const info = await stat(path);
  return { name: basename(path), bytes: info.size, sha256: await sha256File(path) };
}

export async function buildManifest(): Promise<GeoManifest> {
  const mergedPath = join(OUT_DIR, 'merged.osm.pbf');

  // Whatever the download plan actually fetched — per-zone extracts below the
  // whole-country threshold, one india-latest.osm.pbf above it (D51).
  const plan = planDownloads(CITIES);
  const sources: GeoSource[] = [];
  for (const file of plan.files) {
    sources.push(await describe(join(CACHE_DIR, file)));
  }

  const merged = await describe(mergedPath);
  const configHash = computeGeoConfigHash(CITIES);

  return geoManifestSchema.parse({
    version: GEO_MANIFEST_VERSION,
    epoch: computeGeoEpoch({ configHash, sources }),
    configHash,
    generatedAt: new Date().toISOString(),
    downloadStrategy: plan.strategy,
    cities: CITIES.map((city) => ({
      slug: city.slug,
      zone: city.zone,
      bbox: city.bbox,
      // The box artifacts were actually cut from. Recorded separately from the
      // administrative one because they answer different questions (D47), and
      // a manifest that reported only one of them could not tell a reader
      // whether a stale artifact was a padding change or a bounds change.
      paddedBbox: city.paddedBbox,
    })),
    sources,
    merged,
  });
}

export async function readManifest(): Promise<GeoManifest | null> {
  try {
    return geoManifestSchema.parse(JSON.parse(await readFile(MANIFEST_PATH, 'utf8')));
  } catch {
    return null;
  }
}

async function write(): Promise<void> {
  const manifest = await buildManifest();
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`osm-data/manifest.json written`);
  console.log(`  epoch       ${manifest.epoch}`);
  console.log(`  configHash  ${manifest.configHash}`);
  console.log(`  cities      ${manifest.cities.map((city) => city.slug).join(', ')}`);
  console.log(`  strategy    ${manifest.downloadStrategy}`);
  console.log(`  sources     ${manifest.sources.map((source) => source.name).join(', ')}`);
}

async function main(command: string | undefined): Promise<void> {
  switch (command) {
    case 'write':
      await write();
      return;
    case 'print': {
      const manifest = await readManifest();
      console.log(
        manifest ? JSON.stringify(manifest, null, 2) : 'no manifest — run pnpm bootstrap',
      );
      return;
    }
    case 'epoch': {
      const manifest = await readManifest();
      console.log(manifest?.epoch ?? '');
      return;
    }
    default:
      console.error('Usage: tsx scripts/geo-manifest.ts <write|print|epoch>');
      process.exit(1);
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'geo-manifest.ts') {
  await main(process.argv[2]);
}
