// tsc only emits JavaScript. Prisma's generated directory also contains the
// native query engine (and, depending on target, wasm), which the compiled
// client resolves relative to its own location — so those files have to be
// carried into dist alongside the emitted JS.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(packageRoot, 'generated', 'prisma');
const destination = join(packageRoot, 'dist', 'generated', 'prisma');

if (!existsSync(source)) {
  throw new Error(`Prisma client has not been generated yet: ${source}`);
}

let copied = 0;
for (const entry of readdirSync(source, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || entry.name.endsWith('.ts')) continue;

  const from = join(entry.parentPath, entry.name);
  const to = join(destination, from.slice(source.length));
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
  copied += 1;
}

console.log(`copied ${copied} prisma runtime file(s) into dist/generated/prisma`);
