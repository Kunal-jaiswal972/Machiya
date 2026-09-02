/**
 * Generates the placeholder listing photos committed under scripts/fixtures/.
 *
 * Run once (`pnpm fixtures:generate`) and commit the output. The seed uploads
 * these into MinIO so galleries have real image bytes to serve without any
 * external image host, and without committing megabytes of stock photos.
 *
 * They are intentionally plain: gradient plus a label, so it is never ambiguous
 * whether an image is seed data or a real upload.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const WIDTH = 1200;
const HEIGHT = 800;

interface Fixture {
  name: string;
  label: string;
  from: string;
  to: string;
}

const FIXTURES: Fixture[] = [
  { name: 'exterior-01', label: 'Exterior', from: '#1d4ed8', to: '#0ea5e9' },
  { name: 'exterior-02', label: 'Exterior', from: '#0f766e', to: '#22c55e' },
  { name: 'exterior-03', label: 'Exterior', from: '#7c3aed', to: '#ec4899' },
  { name: 'living-01', label: 'Living room', from: '#b45309', to: '#f59e0b' },
  { name: 'living-02', label: 'Living room', from: '#1e293b', to: '#64748b' },
  { name: 'bedroom-01', label: 'Bedroom', from: '#be123c', to: '#fb7185' },
  { name: 'kitchen-01', label: 'Kitchen', from: '#065f46', to: '#34d399' },
  { name: 'balcony-01', label: 'Balcony', from: '#0c4a6e', to: '#38bdf8' },
];

function svg({ label, from, to }: Fixture): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${from}" />
      <stop offset="100%" stop-color="${to}" />
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#g)" />
  <text x="60" y="${HEIGHT - 90}" font-family="system-ui, sans-serif" font-size="64"
        font-weight="600" fill="#ffffff" opacity="0.95">${label}</text>
  <text x="62" y="${HEIGHT - 44}" font-family="system-ui, sans-serif" font-size="26"
        fill="#ffffff" opacity="0.75">Machiya seed data</text>
</svg>`);
}

// Wrapped in a function rather than using top-level await: the repo root is
// CommonJS, so tsx transpiles scripts/ to CJS, where top-level await is a
// syntax error.
async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  let total = 0;
  for (const fixture of FIXTURES) {
    const jpeg = await sharp(svg(fixture)).jpeg({ quality: 72, progressive: true }).toBuffer();
    const target = join(OUT_DIR, `${fixture.name}.jpg`);
    writeFileSync(target, jpeg);
    total += jpeg.byteLength;
    console.log(
      `${fixture.name}.jpg  ${WIDTH}x${HEIGHT}  ${(jpeg.byteLength / 1024).toFixed(0)} KB`,
    );
  }

  console.log(`${FIXTURES.length} fixtures, ${(total / 1024).toFixed(0)} KB total, in ${OUT_DIR}`);
}

void main();
