import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Single PrismaClient for the whole process.
 *
 * Held on globalThis so that tsx/vitest module reloads in development do not
 * open a new connection pool on every hot restart.
 */
const globalForPrisma = globalThis as unknown as {
  __machiyaPrisma?: PrismaClient;
};

export const prisma: PrismaClient =
  globalForPrisma.__machiyaPrisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? [
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ]
        : [{ emit: 'stdout', level: 'error' }],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__machiyaPrisma = prisma;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
