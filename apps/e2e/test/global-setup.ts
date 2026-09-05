import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Redis } from 'ioredis';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The end-to-end suite needs more of the stack up than any other.
 *
 * Postgres is a throwaway container (or `TEST_DATABASE_URL` in CI) because the
 * path truncates and rewrites tables. Redis, MinIO and OSRM are expected to be
 * running — compose in development, service containers in CI — because the
 * whole point of this suite is that none of them is stubbed.
 */
export default async function setup(): Promise<() => Promise<void>> {
  let container: StartedPostgreSqlContainer | undefined;
  let databaseUrl = process.env.TEST_DATABASE_URL;

  if (!databaseUrl) {
    container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
      .withDatabase('machiya_e2e')
      .withUsername('machiya')
      .withPassword('machiya')
      .start();
    databaseUrl = container.getConnectionUri();
  }

  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL ??= 'redis://localhost:6379/3';

  // Rate-limit counters and cached geo answers from a previous run would both
  // change what this suite observes — a 429 on the third sign-up, or a route
  // served from cache instead of measured. The database index is this suite's
  // own (see vitest.config.ts), so flushing it touches nothing else.
  const redis = new Redis(process.env.REDIS_URL);
  await redis.flushdb();
  await redis.quit();

  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  execFileSync(
    process.execPath,
    [prismaCli, 'migrate', 'deploy', '--schema=packages/db/prisma/schema.prisma'],
    {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    },
  );

  return async () => {
    await container?.stop();
  };
}
