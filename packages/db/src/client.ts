import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Single PrismaClient for the whole process.
 *
 * Prisma 7 has no Rust query engine and no `datasource.url` in the schema, so
 * the connection is supplied here by a driver adapter over `pg`. The URL is read
 * from the environment at construction rather than baked in at generate time,
 * which is what lets the same generated client run against the compose database,
 * a testcontainer and CI's service container. See DECISIONS.md D5.
 *
 * Held on globalThis so that tsx/vitest module reloads in development do not
 * open a new connection pool on every hot restart.
 */
const globalForPrisma = globalThis as unknown as {
  __machiyaPrisma?: PrismaClient;
};

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    // Without this the adapter fails later with a pg-level "client password
    // must be a string", which names nothing useful.
    throw new Error('DATABASE_URL is not set — @machiya/db cannot open a connection.');
  }

  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log:
      process.env.NODE_ENV === 'development'
        ? [
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ]
        : [{ emit: 'stdout', level: 'error' }],
  });
}

export const prisma: PrismaClient = globalForPrisma.__machiyaPrisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__machiyaPrisma = prisma;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
