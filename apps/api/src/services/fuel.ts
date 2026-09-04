import { prisma } from '@machiya/db';
import {
  CACHE_TTL_SECONDS,
  FUEL_HEALTH_KEY,
  fuelCacheKey,
  fuelHealthReportSchema,
  fuelSnapshotSchema,
  type FuelHealthReport,
  type FuelSnapshot,
  type FuelType,
} from '@machiya/shared';
import { cityBySlug } from '@machiya/shared/cities';
import { cacheGet } from '../lib/cache.js';
import { enqueueFuelRefresh } from '../lib/queues.js';
import { logger } from '../logger.js';
import { redis } from '../lib/redis.js';

/**
 * Fuel prices, as the API serves them.
 *
 * **The request never blocks on a scrape.** That is the whole shape of this
 * module, and it is a hard rule rather than an optimisation: a scrape walks
 * three sites, takes seconds when it works, and sometimes does not work at all.
 * A page waiting on that is a page that is sometimes twenty seconds slow and
 * then still has nothing.
 *
 * So: read Redis, and on a miss enqueue a refresh and immediately serve the
 * most recent `FuelPrice` row from Postgres with a `staleAt` the UI states out
 * loud. "Prices from 3 hours ago" is useful information. A spinner is not.
 */

/**
 * The freshest thing available, in preference order.
 *
 * Three tiers, and the second is the one that makes the rule above possible:
 *
 *  1. **Redis** — written by the hourly job with a 1-hour TTL, so its presence
 *     IS its freshness. `staleAt: null`.
 *  2. **Postgres history** — the last rows the job stored, whenever that was.
 *     `staleAt` set to the row's timestamp, and a refresh enqueued.
 *  3. **Nothing** — a city that has never been scraped and never seeded. Null,
 *     and the caller shows the commute panel without a fuel figure rather than
 *     inventing one.
 */
export async function getFuelSnapshot(citySlug: string): Promise<FuelSnapshot | null> {
  const cached = await cacheGet<unknown>(fuelCacheKey(citySlug));

  if (cached) {
    const parsed = fuelSnapshotSchema.safeParse(cached);
    if (parsed.success) return parsed.data;

    // A blob from an older shape. Falling through to Postgres is better than
    // serving it: the shape is what the cost engine reads.
    logger.warn({ citySlug }, 'cached fuel snapshot did not match the current shape; ignoring it');
  }

  const snapshot = await fromDatabase(citySlug);

  // Enqueued whether or not the database had anything, because a city with no
  // rows is exactly the one that most needs a scrape. Fire-and-forget: the
  // response does not wait, and a queue that is down must not fail the read.
  void enqueueFuelRefresh(citySlug).catch((error: unknown) => {
    logger.warn({ err: error, citySlug }, 'could not enqueue a fuel refresh');
  });

  return snapshot;
}

/**
 * The last stored prices for a city.
 *
 * One row per fuel type, each the newest for that fuel — not simply the newest
 * nine rows, which would silently drop CNG whenever petrol and diesel had been
 * refreshed more recently. `DISTINCT ON` is the clean way to say that, and it
 * lives in `packages/db` because every line of raw SQL does; this reads it
 * through Prisma's typed API instead, which handles this shape fine.
 */
async function fromDatabase(citySlug: string): Promise<FuelSnapshot | null> {
  const city = await prisma.city.findUnique({
    where: { slug: citySlug },
    select: { id: true },
  });

  if (!city) return null;

  const fuels: FuelType[] = ['PETROL', 'DIESEL', 'CNG'];
  const rows = await Promise.all(
    fuels.map((fuelType) =>
      prisma.fuelPrice.findFirst({
        where: { cityId: city.id, fuelType },
        orderBy: { fetchedAt: 'desc' },
        select: {
          fuelType: true,
          price: true,
          currency: true,
          source: true,
          sourceUrl: true,
          fetchedAt: true,
        },
      }),
    ),
  );

  const present = rows.filter((row): row is NonNullable<typeof row> => row !== null);
  if (present.length === 0) return null;

  // The OLDEST of the rows decides `staleAt`. Reporting the newest would let a
  // fresh petrol row make a three-day-old CNG row look current.
  const oldest = present.reduce(
    (earliest, row) => (row.fetchedAt < earliest ? row.fetchedAt : earliest),
    present[0]!.fetchedAt,
  );

  return {
    citySlug,
    prices: present.map((row) => ({
      fuelType: row.fuelType,
      // Prisma returns Decimal; the wire format and the cost engine both want a
      // number, and a fuel price has two decimals at most.
      price: Number(row.price),
      currency: row.currency,
      source: row.source,
      sourceUrl: row.sourceUrl,
      sources: [row.source],
      fetchedAt: row.fetchedAt.toISOString(),
    })),
    fetchedAt: oldest.toISOString(),
    staleAt: oldest.toISOString(),
    refreshing: true,
  };
}

/**
 * The price for one fuel in one city, for the cost engine.
 *
 * Falls back to the city's default fuel when the requested one has no reading —
 * CNG coverage is genuinely patchy — and returns null rather than a guess when
 * neither is available. A commute cost computed from an invented fuel price is
 * the least defensible number this product could show.
 */
export async function getFuelPrice(
  citySlug: string,
  fuelType: FuelType,
): Promise<{ price: number; fuelType: FuelType; snapshot: FuelSnapshot } | null> {
  const snapshot = await getFuelSnapshot(citySlug);
  if (!snapshot) return null;

  const exact = snapshot.prices.find((price) => price.fuelType === fuelType);
  if (exact) return { price: exact.price, fuelType, snapshot };

  const fallbackType = cityBySlug(citySlug).defaultFuelType;
  const fallback = snapshot.prices.find((price) => price.fuelType === fallbackType);

  if (fallback) {
    logger.info(
      { citySlug, requested: fuelType, served: fallbackType },
      'no reading for the requested fuel; using the city default',
    );
    return { price: fallback.price, fuelType: fallbackType, snapshot };
  }

  return null;
}

/**
 * Per-adapter scrape health, for the admin page.
 *
 * An ABSENT report is not a healthy one. The job writes this without a TTL
 * precisely so that "nothing here" means the job has never run rather than
 * "everything is fine" — so this returns null and the page says which.
 */
export async function getFuelHealth(): Promise<FuelHealthReport | null> {
  try {
    const raw = await redis.get(FUEL_HEALTH_KEY);
    if (!raw) return null;

    const parsed = fuelHealthReportSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    logger.warn({ err: error }, 'could not read fuel adapter health');
    return null;
  }
}

/** Exported for the route's cache header, so the TTL is stated in one place. */
export const FUEL_SNAPSHOT_TTL_SECONDS = CACHE_TTL_SECONDS.fuelPrice;
