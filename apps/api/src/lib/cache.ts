import { redis } from './redis.js';
import { logger } from '../logger.js';

/**
 * Read-through JSON cache over the fail-fast Redis connection.
 *
 * The contract that matters: **a cache failure is never a request failure.** The
 * cache client has no offline queue, so a command issued while Redis is down
 * rejects immediately (D21) — and every call here swallows that and computes the
 * value instead. Nothing in this codebase blocks a page on the cache.
 *
 * `stale` exists because "we could not refresh this" and "there is nothing
 * here" are different answers to a user. A POI panel that shows yesterday's
 * hospitals with a note is useful; one that shows "none nearby" because a free
 * Overpass mirror answered 429 is a lie.
 */
export interface CachedValue<T> {
  value: T;
  /** True when the value came from Redis rather than from the loader. */
  hit: boolean;
  /** True when the loader failed and a previous value was served instead. */
  stale: boolean;
}

/**
 * The cache client is `lazyConnect` with no offline queue (D21), which means
 * the FIRST command of a fresh process is issued before the socket is ready
 * and rejects outright. That is not merely a slow first read: the first cache
 * *write* was dropped too, so a background POI warm right after boot produced
 * nothing and the next viewer warmed the same key again.
 *
 * So connect once, explicitly, and let every read and write await it. Kept out
 * of module scope on purpose: importing this file must not open a socket, or
 * every test that touches a service would need a Redis to run.
 */
let connecting: Promise<void> | null = null;

async function ready(): Promise<void> {
  if (redis.status === 'ready') return;

  if (!connecting && (redis.status === 'wait' || redis.status === 'end')) {
    connecting = redis
      .connect()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        connecting = null;
      });
  }

  // While a connect is in flight, wait for it. While ioredis is reconnecting on
  // its own, do not — a cache miss is always an acceptable answer here.
  if (connecting) await connecting;
}

async function readRaw(key: string): Promise<string | null> {
  try {
    await ready();
    return await redis.get(key);
  } catch (error) {
    logger.debug({ err: error, key }, 'cache read failed');
    return null;
  }
}

async function writeRaw(key: string, payload: string, ttlSeconds: number): Promise<void> {
  try {
    await ready();
    await redis.set(key, payload, 'EX', ttlSeconds);
  } catch (error) {
    logger.debug({ err: error, key }, 'cache write failed');
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const raw = await readRaw(key);
  if (raw === null) return null;

  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt entry is worse than none: drop it rather than serving it.
    void redis.del(key).catch(() => undefined);
    return null;
  }
}

export async function cacheSet<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  await writeRaw(key, JSON.stringify(value), ttlSeconds);
}

/**
 * The usual shape: serve the cached value, otherwise load and store it.
 *
 * When the loader throws and a cached copy exists — even an expired one that
 * `keepStaleFor` extended the life of — that copy is returned with
 * `stale: true`. When the loader throws and there is nothing cached, the error
 * propagates: at that point the caller has to decide what a degraded answer
 * looks like, and this function cannot.
 */
export async function cached<T>(options: {
  key: string;
  ttlSeconds: number;
  load: () => Promise<T>;
  /**
   * Additional seconds a value is kept under a `:stale` key after its TTL, as a
   * fallback for when the upstream is refusing. Zero disables it.
   */
  keepStaleFor?: number;
}): Promise<CachedValue<T>> {
  const { key, ttlSeconds, load, keepStaleFor = 0 } = options;

  const hit = await cacheGet<T>(key);
  if (hit !== null) return { value: hit, hit: true, stale: false };

  try {
    const value = await load();
    await cacheSet(key, value, ttlSeconds);
    if (keepStaleFor > 0) {
      await cacheSet(`${key}:stale`, value, ttlSeconds + keepStaleFor);
    }
    return { value, hit: false, stale: false };
  } catch (error) {
    if (keepStaleFor > 0) {
      const fallback = await cacheGet<T>(`${key}:stale`);
      if (fallback !== null) {
        logger.warn({ err: error, key }, 'serving a stale cache entry after an upstream failure');
        return { value: fallback, hit: true, stale: true };
      }
    }
    throw error;
  }
}

/**
 * Normalises a free-text query into a cache key fragment.
 *
 * Without this, "Boring Road", "boring  road" and "BORING ROAD " are three
 * separate cache entries and three separate upstream calls for one answer.
 */
export function normalizeQueryKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}
