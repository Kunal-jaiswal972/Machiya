// maplibre-gl 6 resolves its tile-parsing worker at RUNTIME, relative to its own
// module URL: `new URL('./maplibre-gl-worker.mjs', import.meta.url)`. Once Rollup
// inlines maplibre into a hashed app chunk that URL points at /assets/, where no
// such file exists — and because maplibre falls back to `new Worker('')` it fails
// SILENTLY: style, sprite and TileJSON all load, no error is raised, and the map
// renders as an empty background forever.
//
// So the worker pair is copied verbatim into public/ and handed to maplibre via
// setWorkerUrl(). The worker imports './maplibre-gl-shared.mjs' as a sibling, so
// both files must land in the same directory.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const maplibreDist = dirname(fileURLToPath(import.meta.resolve('maplibre-gl')));
const target = join(appRoot, 'public', 'maplibre');

mkdirSync(target, { recursive: true });

for (const file of WORKER_FILES) {
  const from = join(maplibreDist, file);
  if (!existsSync(from)) {
    throw new Error(
      `Expected ${file} in ${maplibreDist}. maplibre-gl changed its dist layout — ` +
        'check how the worker is resolved before bumping the version.',
    );
  }
  const to = join(target, file);
  copyFileSync(from, to);
  console.log(`maplibre worker asset: ${file} (${statSync(to).size} bytes)`);
}
