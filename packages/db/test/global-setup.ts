import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

// Prisma 7 reads the connection string from prisma.config.ts, which lives at
// the repo root — so the CLI has to be invoked from there, not from this
// package. Running it here fails with "datasource.url property is required".
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * These tests run against real PostGIS, never a mock — the whole point is to
 * prove ST_DWithin, the ring arithmetic, the KNN ordering and the sync trigger
 * behave as the queries assume.
 *
 * TEST_DATABASE_URL wins when set (CI provides a postgis service container).
 * Otherwise a throwaway container is started here. The developer's own
 * DATABASE_URL is never used: this setup truncates tables.
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

  // Worker processes are forked after this returns, so they inherit this.
  process.env.DATABASE_URL = databaseUrl;

  // Invoke the Prisma CLI's entry module with this Node binary rather than the
  // `prisma` shim: Node refuses to spawn a .cmd without a shell on Windows, and
  // going through a shell would mean quoting the paths by hand.
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
