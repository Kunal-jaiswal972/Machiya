import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../env.js';
import { logger } from '../logger.js';

function connect(name: string, options: RedisOptions): Redis {
  const client = new Redis(env.REDIS_URL, options);

  client.on('error', (error: Error) => {
    logger.warn({ err: error, connection: name }, 'redis connection error');
  });

  return client;
}

/**
 * Cache connection: POI results, route geometries, geocode lookups, fuel prices.
 *
 * Deliberately fail-fast — `lazyConnect` keeps imports side-effect free, and no
 * offline queue means a command issued while Redis is unreachable rejects
 * immediately instead of hanging a request. Every caller of this client has a
 * Postgres fallback or can serve a degraded result.
 */
export const redis = connect('cache', {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
});

/**
 * Auth connection: Better Auth's session cache and rate-limit counters.
 *
 * The opposite policy on purpose. This one is on the credential path, where
 * there is no fallback: with the cache client's settings, the rate limiter's
 * very first INCR — issued before anything had triggered a connect — threw
 * "Stream isn't writeable and enableOfflineQueue options is false" and turned
 * every sign-up into a 500. So it connects eagerly and queues commands through
 * a reconnect. See DECISIONS.md D21.
 */
export const authRedis = connect('auth', {
  lazyConnect: false,
  maxRetriesPerRequest: 3,
  enableOfflineQueue: true,
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
  await Promise.allSettled(
    [redis, authRedis].map((client) => (client.status === 'end' ? undefined : client.quit())),
  );
}
