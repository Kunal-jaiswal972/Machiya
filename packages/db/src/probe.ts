import { prisma } from './client.js';

export interface DatabaseProbe {
  ok: boolean;
  /** PostGIS version available on the server, or undefined if it is not installed. */
  postgisVersion?: string;
}

/**
 * Confirms the database answers queries AND that PostGIS is present.
 *
 * Reads `pg_available_extensions` rather than calling `postgis_version()` so the
 * probe still reports honestly before the extension-creating migration has run.
 */
export async function probeDatabase(): Promise<DatabaseProbe> {
  const rows = await prisma.$queryRaw<Array<{ version: string | null }>>`
    SELECT COALESCE(installed_version, default_version) AS version
    FROM pg_available_extensions
    WHERE name = 'postgis'
    LIMIT 1
  `;

  const version = rows[0]?.version ?? undefined;
  return { ok: version !== undefined, ...(version ? { postgisVersion: version } : {}) };
}
