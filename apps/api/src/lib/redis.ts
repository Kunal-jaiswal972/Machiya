import { Redis } from 'ioredis';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * Shared connection for cache reads and writes.
 *
 * `lazyConnect` keeps `import` side-effect free so tests can load the app without
 * a live Redis; the first command opens the socket.
 */
export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
});

redis.on('error', (error: Error) => {
  logger.warn({ err: error }, 'redis connection error');
});

export interface RedisProbe {
  ok: boolean;
  detail?: string;
}

export async function probeRedis(): Promise<RedisProbe> {
  if (redis.status === 'wait' || redis.status === 'end') {
    await redis.connect();
  }
  const reply = await redis.ping();
  return { ok: reply === 'PONG', detail: reply };
}

export async function closeRedis(): Promise<void> {
  if (redis.status !== 'end') {
    await redis.quit();
  }
}
