import { Redis } from 'ioredis';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * The worker's cache connection, separate from the one BullMQ blocks on.
 *
 * Two connections rather than one, for the same reason the API has two (D21):
 * BullMQ needs `maxRetriesPerRequest: null` because it holds blocking reads
 * open, and a cache client with that setting hangs forever instead of failing.
 * The fuel job writes a snapshot and a health report through this one, and both
 * writes are allowed to fail — the Postgres history row is what the API falls
 * back to, so a dead Redis costs freshness, not availability.
 *
 * Eager rather than lazy, unlike the API's cache client: this process exists to
 * run jobs, so there is no import-time cost worth avoiding, and the first
 * command of a scrape should not be the one that discovers the socket.
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 2,
  enableOfflineQueue: true,
});

redis.on('error', (error: Error) => {
  logger.warn({ err: error, connection: 'worker-cache' }, 'redis connection error');
});

export async function closeWorkerRedis(): Promise<void> {
  if (redis.status !== 'end') {
    await redis.quit();
  }
}
