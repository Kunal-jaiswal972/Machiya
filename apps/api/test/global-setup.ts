import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

// Prisma 7 reads the connection string from prisma.config.ts at the repo root,
// so the CLI has to run from there rather than from packages/db.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The listing service tests run against real PostGIS: ownership, cascades, the
 * publish gate and the seeker-to-lister upgrade are all database behaviour, and
 * a mocked client would prove none of it.
 *
 * TEST_DATABASE_URL wins when set (CI provides a postgis service container);
 * otherwise a throwaway container is started. The developer's own DATABASE_URL
 * is never used, because these tests truncate tables.
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
