/**
 * Prisma 7 configuration.
 *
 * Prisma 7 removed `datasource.url` from the schema file and stopped loading
 * `.env` on its own, so this file is what makes `prisma migrate`, `prisma
 * db seed` and `prisma studio` work at all. It lives at the repo root, not in
 * `packages/db`, so the root `.env` stays the single source of environment
 * truth for the CLI and the apps alike — see DECISIONS.md D4 and D5.
 *
 * Paths are relative to THIS file's directory, which Prisma resolves for us, so
 * every `pnpm db:*` script keeps working from anywhere in the workspace.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

// `.env` is resolved from this file rather than from the current directory: a
// package script that invokes the CLI from its own folder would otherwise find
// no `.env` at all. Node's own loader is used instead of `dotenv` so this config
// needs no dependency — it runs inside the Docker build, where only the
// production dependency tree is installed. Like `--env-file`, it does not
// overwrite variables that are already set, which is what lets the test setups
// and CI hand it a different database.
try {
  process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '.env'));
} catch {
  // No .env — fine when the environment is already populated (CI, compose).
}

const url = process.env.DATABASE_URL;

if (!url) {
  // Without this the failure is an opaque "environment variable not found"
  // from inside the schema parser. Say what to do about it instead.
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env at the repo root, or export it before running a prisma command.',
  );
}

export default defineConfig({
  schema: 'packages/db/prisma/schema.prisma',
  migrations: {
    path: 'packages/db/prisma/migrations',
    // `prisma migrate reset` and `prisma db seed` run this, and Prisma 7 will
    // not load `.env` for it — so the flag is part of the command, and it is
    // byte-identical to the root `db:seed` script for that reason.
    seed: 'tsx --env-file-if-exists=.env packages/db/prisma/seed.ts',
  },
  datasource: { url },
});
