import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

// Prisma 7 reads the connection string from prisma.config.ts at the repo root,
// so the CLI has to run from there rather than from packages/db.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The reconciler is a claim about two systems agreeing — a committed Postgres
 * row and a Redis queue — so it is tested against both for real. A mocked queue
 * would prove nothing about `getJob`, job states or id collisions, which is
 * exactly where the bug it fixes lives.
 *
 * TEST_DATABASE_URL wins when set (CI provides a postgis service container);
 * otherwise a throwaway container is started. Redis comes from REDIS_URL and is
 * expected to be running — compose in development, a service container in CI.
 */
export default async function setup(): Promise<() => Promise<void>> {
  let container: StartedPostgreSqlContainer | undefined;
  let databaseUrl = process.env.TEST_DATABASE_URL;

  if (!databaseUrl) {
    container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
      .withDatabase('machiya_test')
      .withUsername('machiya')
      .withPassword('machiya')
      .start();
    databaseUrl = container.getConnectionUri();
  }

  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL ??= 'redis://localhost:6379';

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
