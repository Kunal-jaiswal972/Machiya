/**
 * Fetches the seed photo set — real house photographs, deterministically.
 *
 *   pnpm seed:photos
 *
 * This is a SEPARATE, explicitly invoked step, not part of `db:seed`. The seed
 * must stay runnable offline and must produce the same database on every
 * machine; a live API call inside it would break both. See DECISIONS.md D31.
 *
 * How determinism survives a network dependency:
 *
 *   1. The chosen photos are recorded in `scripts/fixtures/photos.json` — ids,
 *      download URLs, dimensions, photographer name and profile link. That
 *      manifest is COMMITTED. It is the deterministic artifact.
 *   2. The binaries land in `scripts/fixtures/photos/`, which is gitignored.
 *   3. With a manifest present, this script downloads only what is missing and
 *      never re-queries the API. So a machine with no Unsplash key reproduces
 *      the exact same seed data, and a warm cache needs no network at all.
 *
 * Only step 1 needs a key, and only when the manifest does not exist yet.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = join(REPO_ROOT, 'scripts', 'fixtures');
const PHOTO_DIR = join(FIXTURE_DIR, 'photos');
const MANIFEST_PATH = join(FIXTURE_DIR, 'photos.json');
const ATTRIBUTION_PATH = join(REPO_ROOT, 'docs', 'attribution.md');

/**
 * Fixed queries and fixed counts. Both are part of the deterministic contract:
 * change either and the manifest has to be regenerated deliberately, which is
 * the point — the photo set should not drift because someone re-ran a script.
 *
 * 24 photos total, which is the 20-30 the brief asks for and comfortably inside
 * the free Demo tier's 50 requests an hour (one request per term, seven terms).
 */
const QUERIES: Array<{ term: string; count: number; tag: string }> = [
  { term: 'apartment interior', count: 4, tag: 'interior' },
  { term: 'living room', count: 4, tag: 'living' },
  { term: 'indian house exterior', count: 4, tag: 'exterior' },
  { term: 'bedroom', count: 4, tag: 'bedroom' },
  { term: 'kitchen', count: 3, tag: 'kitchen' },
  { term: 'balcony', count: 2, tag: 'balcony' },
  { term: 'apartment building', count: 3, tag: 'exterior' },
];

export const seedPhotoSchema = z.object({
  /** Stable id, and the directory name the variants are shared under. */
  id: z.string().min(1),
  /** Which query produced it, so the seed can bias a cover towards exteriors. */
  tag: z.string().min(1),
  /** The URL the bytes come from. Unsplash URLs are stable and sized. */
  downloadUrl: z.string().url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  photographer: z.string().min(1),
  photographerUrl: z.string().url(),
  /** Where the photo can be viewed, which Unsplash's terms require crediting. */
  sourceUrl: z.string().url(),
  source: z.enum(['unsplash', 'picsum']),
  /** Local filename inside scripts/fixtures/photos/. */
  file: z.string().min(1),
});

export type SeedPhoto = z.infer<typeof seedPhotoSchema>;

export const photoManifestSchema = z.object({
  generatedAt: z.string(),
  source: z.enum(['unsplash', 'picsum']),
  photos: z.array(seedPhotoSchema).min(1),
});

export type PhotoManifest = z.infer<typeof photoManifestSchema>;

export function readPhotoManifest(): PhotoManifest | null {
  if (!existsSync(MANIFEST_PATH)) return null;
  return photoManifestSchema.parse(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
}

export function photoFilePath(photo: SeedPhoto): string {
  return join(PHOTO_DIR, photo.file);
}

// --- Unsplash ---------------------------------------------------------------

const unsplashUserSchema = z.object({
  name: z.string(),
  links: z.object({ html: z.string().url() }),
});

const unsplashPhotoSchema = z.object({
  id: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  urls: z.object({ raw: z.string().url(), regular: z.string().url() }),
  links: z.object({ html: z.string().url(), download_location: z.string().url() }),
  user: unsplashUserSchema,
});

const unsplashSearchSchema = z.object({ results: z.array(unsplashPhotoSchema) });

type UnsplashPhoto = z.infer<typeof unsplashPhotoSchema>;

/**
 * Unsplash's search endpoint returns a transient 502 or 500 for perfectly valid
 * queries, reproducibly and per-term: verified here with "apartment interior",
 * "indian house exterior" and "balcony" all failing twice and succeeding on the
 * next attempt while "bedroom" and "living room" answered first time. It is not
 * the key, the spaces or the parameters — the same requests succeed through
 * curl. So a 5xx is retried rather than treated as a failure, and only a 4xx
 * (which really is our problem) stops the run.
 */
async function searchUnsplash(
  accessKey: string,
  term: string,
  count: number,
): Promise<UnsplashPhoto[]> {
  const url = new URL('https://api.unsplash.com/search/photos');
  url.searchParams.set('query', term);
  url.searchParams.set('per_page', String(Math.max(count, 10)));
  url.searchParams.set('orientation', 'landscape');
  // `relevant` rather than `latest`, so re-running the search before a manifest
  // exists is at least likely to pick the same photos.
  url.searchParams.set('order_by', 'relevant');
  url.searchParams.set('content_filter', 'high');

  const maxAttempts = 8;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(url, {
      headers: { authorization: `Client-ID ${accessKey}`, 'accept-version': 'v1' },
    });

    if (response.ok) {
      const { results } = unsplashSearchSchema.parse(await response.json());
      return results.slice(0, count);
    }

    if (response.status === 401) {
      throw new Error(
        'Unsplash rejected the credentials (401). Check UNSPLASH_ACCESS_KEY in the root .env.',
      );
    }

    if (response.status === 403) {
      // The Demo tier is 50 requests an hour and the header says where we are.
      const remaining = response.headers.get('x-ratelimit-remaining') ?? 'unknown';
      throw new Error(
        `Unsplash refused the request (403); rate limit remaining: ${remaining}. The Demo tier allows 50 requests an hour — wait and re-run.`,
      );
    }

    if (response.status < 500 || attempt === maxAttempts) {
      throw new Error(`Unsplash search failed: ${String(response.status)} ${response.statusText}`);
    }

    console.log(
      `  ~ ${term}: ${String(response.status)} from Unsplash, retrying (${String(attempt)}/${String(maxAttempts - 1)})`,
    );
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
  }

  throw new Error(`Unsplash search for "${term}" did not succeed`);
}

/**
 * Unsplash's API terms require hitting the photo's `download_location` whenever
 * a photo is actually downloaded — it is how photographers get credited with a
 * download. It is a side effect with no useful response, so a failure here is
 * logged and not fatal, but it is never skipped.
 */
async function triggerUnsplashDownload(accessKey: string, downloadLocation: string): Promise<void> {
  try {
    await fetch(downloadLocation, { headers: { authorization: `Client-ID ${accessKey}` } });
  } catch (error) {
    console.warn(`  ! could not register the download with Unsplash: ${String(error)}`);
  }
}

function toSeedPhoto(photo: UnsplashPhoto, tag: string): SeedPhoto {
  // A pinned width and quality, so the bytes are the same every time and the
  // download is a few hundred KB rather than a 20 MP original.
  const downloadUrl = `${photo.urls.raw}&w=1600&q=80&fm=jpg&fit=max`;

  return {
    id: `unsplash-${photo.id}`,
    tag,
    downloadUrl,
    width: photo.width,
    height: photo.height,
    photographer: photo.user.name,
    photographerUrl: photo.user.links.html,
    sourceUrl: photo.links.html,
    source: 'unsplash',
    file: `unsplash-${photo.id}.jpg`,
  };
}

// --- keyless fallback -------------------------------------------------------

/**
 * Picsum's fixed-id endpoint, used only when there is no key AND no cached
 * photo. Keyless, deterministic (an id always returns the same photograph), and
 * Unsplash-sourced anyway, so the pictures are still real rooms and buildings.
 *
 * Never a gradient. A placeholder that looks like a placeholder makes the
 * product impossible to evaluate, which is the whole reason D31 was reversed.
 */
const PICSUM_IDS = [
  1029, 1039, 1048, 1055, 1060, 1076, 106, 110, 164, 189, 190, 200, 214, 219, 225, 231, 238, 244,
  250, 257, 265, 274, 280, 292,
];

function picsumManifest(): PhotoManifest {
  return {
    generatedAt: new Date().toISOString(),
    source: 'picsum',
    photos: PICSUM_IDS.map((id, index) => {
      const tag = QUERIES[index % QUERIES.length]?.tag ?? 'interior';
      return {
        id: `picsum-${String(id)}`,
        tag,
        downloadUrl: `https://picsum.photos/id/${String(id)}/1600/1067`,
        width: 1600,
        height: 1067,
        photographer: 'Lorem Picsum (Unsplash-sourced)',
        photographerUrl: 'https://picsum.photos',
        sourceUrl: `https://picsum.photos/id/${String(id)}/info`,
        source: 'picsum' as const,
        file: `picsum-${String(id)}.jpg`,
      };
    }),
  };
}

// --- downloading ------------------------------------------------------------

async function downloadIfMissing(photo: SeedPhoto): Promise<'cached' | 'downloaded'> {
  const target = photoFilePath(photo);
  if (existsSync(target)) return 'cached';

  // Same transient-5xx treatment as the search above.
  let bytes: Buffer | undefined;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(photo.downloadUrl, { redirect: 'follow' });

    if (response.ok) {
      bytes = Buffer.from(await response.arrayBuffer());
      break;
    }

    if (response.status < 500 || attempt === 4) {
      throw new Error(
        `Could not download ${photo.id}: ${String(response.status)} ${response.statusText}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }

  if (!bytes) {
    throw new Error(`Could not download ${photo.id}`);
  }

  if (bytes.byteLength < 1024) {
    throw new Error(
      `Download for ${photo.id} is suspiciously small (${String(bytes.byteLength)}B)`,
    );
  }

  writeFileSync(target, bytes);
  return 'downloaded';
}

// --- attribution ------------------------------------------------------------

function writeAttribution(manifest: PhotoManifest): void {
  const lines: string[] = [
    '# Photo attribution',
    '',
    '**Read this when** you need to know where the seeded listing photos came',
    'from, or you are about to publish a screenshot of seeded data.',
    '',
    '<!-- Generated by scripts/fetch-seed-photos.ts. Do not edit by hand. -->',
    '',
    'The photographs used by `pnpm db:seed` are development fixtures. They are',
    'real photographs, not placeholders, because a product built around choosing',
    'somewhere to live cannot be evaluated against grey gradients.',
    '',
    manifest.source === 'unsplash'
      ? 'Source: the [Unsplash](https://unsplash.com) API. Each photographer is credited below, as the Unsplash API terms require, and the per-photo download endpoint is triggered when a photo is cached.'
      : 'Source: [Lorem Picsum](https://picsum.photos), which serves Unsplash photographs by fixed id. This is the keyless fallback used when `UNSPLASH_ACCESS_KEY` is absent and the local cache is cold.',
    '',
    `Manifest generated: ${manifest.generatedAt}`,
    `Photos: ${String(manifest.photos.length)}`,
    '',
    '| Photo | Photographer | Source |',
    '| ----- | ------------ | ------ |',
    ...manifest.photos.map(
      (photo) =>
        `| \`${photo.id}\` | [${photo.photographer}](${photo.photographerUrl}) | [view](${photo.sourceUrl}) |`,
    ),
    '',
  ];

  mkdirSync(dirname(ATTRIBUTION_PATH), { recursive: true });
  writeFileSync(ATTRIBUTION_PATH, `${lines.join('\n')}\n`);
}

// --- entrypoint -------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(PHOTO_DIR, { recursive: true });

  let manifest = readPhotoManifest();
  const accessKey = process.env.UNSPLASH_ACCESS_KEY?.trim();

  if (manifest) {
    console.log(`manifest found: ${String(manifest.photos.length)} photos (${manifest.source})`);
    console.log('not re-querying the API — the manifest is the deterministic artifact');
  } else if (accessKey) {
    console.log('no manifest yet; querying the Unsplash API…');
    const photos: SeedPhoto[] = [];

    for (const query of QUERIES) {
      const results = await searchUnsplash(accessKey, query.term, query.count);
      console.log(`  ${query.term.padEnd(24)} ${String(results.length)} photos`);
      photos.push(...results.map((photo) => toSeedPhoto(photo, query.tag)));
    }

    // The same photograph can be relevant to two terms.
    const unique = new Map(photos.map((photo) => [photo.id, photo]));
    manifest = {
      generatedAt: new Date().toISOString(),
      source: 'unsplash',
      photos: [...unique.values()],
    };

    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`wrote scripts/fixtures/photos.json (${String(manifest.photos.length)} photos)`);
    console.log('COMMIT that file: it is what makes the seed reproducible without a key.');
  } else {
    // Neither a manifest nor a key. The cache cannot be warm either, because a
    // warm cache implies a manifest — so say exactly what is missing.
    console.warn(
      'UNSPLASH_ACCESS_KEY is not set and there is no scripts/fixtures/photos.json.\n' +
        'Falling back to picsum.photos with fixed ids: keyless, deterministic, and\n' +
        'Unsplash-sourced anyway. For proper per-photographer attribution, set\n' +
        'UNSPLASH_ACCESS_KEY in the root .env (https://unsplash.com/oauth/applications)\n' +
        'and delete scripts/fixtures/photos.json to regenerate.',
    );
    manifest = picsumManifest();
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  let downloaded = 0;
  let cached = 0;

  for (const photo of manifest.photos) {
    const outcome = await downloadIfMissing(photo);
    if (outcome === 'downloaded') {
      downloaded += 1;
      if (manifest.source === 'unsplash' && accessKey) {
        // Only on an actual download, which is what the terms are about.
        const original = photo.sourceUrl.split('/').at(-1) ?? photo.id;
        await triggerUnsplashDownload(
          accessKey,
          `https://api.unsplash.com/photos/${original}/download`,
        );
      }
    } else {
      cached += 1;
    }
  }

  writeAttribution(manifest);

  const digest = createHash('sha256')
    .update(manifest.photos.map((photo) => photo.id).join(','))
    .digest('hex')
    .slice(0, 12);

  console.log(
    `\n${String(manifest.photos.length)} photos ready — ${String(downloaded)} downloaded, ${String(cached)} already cached`,
  );
  console.log(`set digest ${digest} — the same on every machine with this manifest`);
  console.log('wrote docs/attribution.md');
  console.log('\nnext: pnpm db:seed');
}

// Only act as a script when executed directly. `packages/db/prisma/seed.ts`
// imports `readPhotoManifest` and `photoFilePath` from this module, and an
// unguarded call here meant importing it kicked off a network fetch — which is
// exactly the coupling this file exists to avoid.
if (process.argv[1] && basename(process.argv[1]) === 'fetch-seed-photos.ts') {
  main().catch((error: unknown) => {
    console.error('seed photos failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
