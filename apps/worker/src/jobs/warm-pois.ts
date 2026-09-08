import { prisma } from '@machiya/db';
import { GEO_EPOCH_UNBUILT } from '@machiya/shared/cities';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { redis } from '../lib/redis.js';

/** Redis key holding the epoch the cache was last fully warmed for. */
const GATE_KEY = 'poi-warm:epoch';

export interface WarmPoisResult {
  /** The geo epoch this run warmed against, or null when it could not be read. */
  epoch: string | null;
  /** Why the run did nothing, when it did nothing. */
  skipped?: 'unreachable' | 'artifacts-unbuilt' | 'already-warmed';
  /** Listings whose POI set was requested. */
  requested: number;
  /** Requests that answered 200. */
  warmed: number;
  /** Requests that did not. */
  failed: number;
  /** True when the API rate-limited the warm and it stopped early. */
  rateLimited?: boolean;
}

/**
 * Fills the POI cache for every published listing, once per geo epoch.
 *
 * POIs are the one derived geo product that CAN be precomputed. A route is
 * keyed by the office pin the user drags, so its key space is unbounded and
 * nothing can be warmed ahead of a request. A listing's POI set is centred on
 * the listing itself — `GET /api/listings/:slug/pois` takes no coordinates — so
 * the set of keys is exactly the set of published listings, and it is known
 * before anyone visits.
 *
 * Worth doing because an Overpass miss is the most expensive miss in the app: a
 * cold read starts a background warm and waits only a bounded moment for it, so
 * the first viewer of a listing gets an empty-ish panel and a "could not
 * refresh" note that is honest but avoidable. After a rebuild every POI key
 * goes cold at once, which is precisely when a human is most likely to be
 * clicking around.
 *
 * The warm goes through the API's own endpoint rather than reaching for Overpass
 * directly. That is deliberate: the cache key, the radius, the category list and
 * the epoch prefix are then identical to the request path by construction, not
 * by a second implementation that has to be kept in step. `sharp` stays out of
 * the API for the opposite reason (D7) — here the duplication is the risk, not
 * the dependency.
 *
 * Epoch-gated through Redis so this is a no-op on almost every tick. A rebuild
 * changes the epoch, the gate opens once, and the run closes it again. See
 * DECISIONS.md D86.
 */
export async function warmPois(): Promise<WarmPoisResult> {
  const geo = await readGeoStatus();

  if (!geo) {
    return { epoch: null, skipped: 'unreachable', requested: 0, warmed: 0, failed: 0 };
  }

  // `unbuilt` is the honest state of a checkout that has never run bootstrap,
  // and warming against it would fill the cache with keys a later rebuild
  // strands anyway.
  if (geo.epoch === GEO_EPOCH_UNBUILT) {
    return { epoch: geo.epoch, skipped: 'artifacts-unbuilt', requested: 0, warmed: 0, failed: 0 };
  }

  const done = await readGate(GATE_KEY);
  if (done === geo.epoch) {
    return { epoch: geo.epoch, skipped: 'already-warmed', requested: 0, warmed: 0, failed: 0 };
  }

  const listings = await prisma.listing.findMany({
    where: { status: 'PUBLISHED' },
    select: { slug: true },
    orderBy: { createdAt: 'asc' },
  });

  logger.info({ epoch: geo.epoch, listings: listings.length }, 'warming POI cache');

  let warmed = 0;
  let failed = 0;
  let requested = 0;
  let rateLimited = false;

  // Strictly serial, with a pause between requests. Overpass answers one query
  // at a time behind fcgiwrap and the whole point is to be considerate of a
  // service nobody is waiting on — the same reasoning that keeps the fuel scrape
  // at concurrency 1.
  for (const { slug } of listings) {
    requested += 1;
    const outcome = await requestPois(slug);

    // The API's limiter is per-IP and the worker is its own container, so the
    // warm cannot spend a real visitor's budget — but it can spend its own, and
    // then every remaining request in this pass would fail for a reason that has
    // nothing to do with the listing. Stop instead, leave the gate open, and let
    // the next tick continue.
    if (outcome === 'rate-limited') {
      rateLimited = true;
      logger.warn(
        { slug, warmed, remaining: listings.length - requested },
        'POI warm rate-limited; stopping this pass',
      );
      break;
    }

    if (outcome === 'ok') warmed += 1;
    else failed += 1;

    await sleep(env.POI_WARM_DELAY_MS);
  }

  // Only when the pass was complete AND clean. A partial warm that closed the
  // gate would leave the listings it missed cold until the NEXT rebuild, which
  // is a worse failure than running again on the next tick.
  const complete = failed === 0 && !rateLimited;
  if (complete) {
    await writeGate(GATE_KEY, geo.epoch);
  }

  logger.info(
    { epoch: geo.epoch, requested, warmed, failed, rateLimited, gateClosed: complete },
    'POI cache warm finished',
  );

  return { epoch: geo.epoch, requested, warmed, failed, ...(rateLimited ? { rateLimited } : {}) };
}

async function readGeoStatus(): Promise<{ epoch: string } | null> {
  try {
    // 503 is expected and useful here: /health/geo answers it when the artifacts
    // predate the city config, and the body still carries the epoch.
    const response = await fetch(`${env.API_INTERNAL_URL}/health/geo`, {
      headers: warmHeaders(),
      signal: AbortSignal.timeout(env.POI_WARM_REQUEST_TIMEOUT_MS),
    });
    const body: unknown = await response.json();

    if (typeof body === 'object' && body !== null && 'epoch' in body) {
      const { epoch } = body as { epoch: unknown };
      if (typeof epoch === 'string') return { epoch };
    }

    logger.warn({ status: response.status }, 'geo health payload carried no epoch');
    return null;
  } catch (error) {
    logger.debug({ err: error }, 'geo health unreachable; skipping POI warm');
    return null;
  }
}

/**
 * The header this job identifies itself with, plus the limiter exemption when
 * one is configured.
 *
 * The User-Agent is for humans reading a log; it deliberately does NOT earn the
 * exemption, because a client-supplied name is trivially forged and a rate limit
 * that any caller can opt out of is not a rate limit. `x-internal-token` is the
 * thing the API actually checks, and an unset token exempts nothing. See
 * DECISIONS.md D86.
 */
export function warmHeaders(): Record<string, string> {
  return {
    'user-agent': env.POI_WARM_USER_AGENT,
    accept: 'application/json',
    ...(env.INTERNAL_REQUEST_TOKEN ? { 'x-internal-token': env.INTERNAL_REQUEST_TOKEN } : {}),
  };
}

type RequestOutcome = 'ok' | 'failed' | 'rate-limited';

async function requestPois(slug: string): Promise<RequestOutcome> {
  try {
    const response = await fetch(
      `${env.API_INTERNAL_URL}/api/listings/${encodeURIComponent(slug)}/pois`,
      {
        headers: warmHeaders(),
        signal: AbortSignal.timeout(env.POI_WARM_REQUEST_TIMEOUT_MS),
      },
    );

    if (response.status === 429) return 'rate-limited';

    if (!response.ok) {
      logger.warn({ slug, status: response.status }, 'POI warm request failed');
      return 'failed';
    }

    // The body is read and dropped: the point is the write the API made into
    // Redis on the way past, not the payload.
    await response.arrayBuffer();
    return 'ok';
  } catch (error) {
    logger.warn({ slug, err: error }, 'POI warm request threw');
    return 'failed';
  }
}

async function readGate(key: string): Promise<string | null> {
  try {
    return await redis.get(key);
  } catch (error) {
    // A gate that cannot be read means the warm runs again, which is wasteful
    // but never wrong.
    logger.debug({ err: error, key }, 'POI warm gate unreadable');
    return null;
  }
}

async function writeGate(key: string, epoch: string): Promise<void> {
  try {
    await redis.set(key, epoch);
  } catch (error) {
    logger.warn({ err: error, key }, 'POI warm gate could not be closed');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
