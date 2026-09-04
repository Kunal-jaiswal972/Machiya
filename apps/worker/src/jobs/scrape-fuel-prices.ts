import { prisma } from '@machiya/db';
import {
  CACHE_TTL_SECONDS,
  FUEL_ADAPTER_DEAD_AFTER_RUNS,
  FUEL_HEALTH_KEY,
  fuelCacheKey,
  pickConsensus,
  type FuelAdapterHealth,
  type FuelAdapterOutcome,
  type FuelHealthReport,
  type FuelQuote,
  type FuelSnapshot,
  type FuelType,
} from '@machiya/shared';
import { CITIES, FUEL_SOURCES, fuelSourceById } from '@machiya/shared/cities';
import { FUEL_ADAPTERS, runAdapter } from '../fuel/index.js';
import { logger } from '../logger.js';
import { redis } from '../lib/redis.js';

/**
 * The hourly fuel scrape.
 *
 * Shape of the thing, and each part is a requirement rather than a preference:
 *
 *  - **every adapter is asked for every city**, and none of them can fail the
 *    run. Source failure is the normal case here.
 *  - **the median of what answered** becomes the served price, keeping a real
 *    quote so attribution still points at a page (D62).
 *  - **Redis gets the snapshot** under `fuel:{citySlug}` with a 1-hour TTL, so
 *    the API can read it and never block on a scrape.
 *  - **Postgres gets a history row** per city per fuel, which is what the API
 *    falls back to on a cache miss and what a chart would read.
 *  - **health is written per adapter**, because the interesting failure is one
 *    source dying quietly while the others cover for it.
 *
 * Nothing here throws for a scraping failure. It throws only if Redis and
 * Postgres are both unusable, which is a real outage and worth a retry.
 */

/** Adapters are run in series per city, deliberately — see `scrapeFuelPrices`. */
async function scrapeCity(
  city: (typeof CITIES)[number],
  signal?: AbortSignal,
): Promise<FuelAdapterOutcome[]> {
  const outcomes: FuelAdapterOutcome[] = [];

  for (const adapter of FUEL_ADAPTERS) {
    outcomes.push(await runAdapter({ adapter, city, ...(signal ? { signal } : {}) }));
  }

  return outcomes;
}

/**
 * Which upstream feed a source belongs to, from the registry.
 *
 * Sources that share data are one vote, not several — `bankbazaar` and
 * `petrolpriceindia` return identical figures, so without this the shared feed
 * outvotes the independent one every time. The family name is the sorted ids
 * joined, so it is stable whichever member is asked.
 */
function feedOf(sourceId: string): string {
  const source = fuelSourceById(sourceId);
  if (!source) return sourceId;
  return [source.id, ...(source.sharesFeedWith ?? [])].sort().join('+');
}

function snapshotFor(citySlug: string, quotes: FuelQuote[]): FuelSnapshot {
  const byFuel = new Map<FuelType, FuelQuote[]>();

  for (const quote of quotes) {
    const existing = byFuel.get(quote.fuelType);
    if (existing) existing.push(quote);
    else byFuel.set(quote.fuelType, [quote]);
  }

  const prices = [...byFuel.values()]
    .map((group) => pickConsensus(group, { feedOf }))
    .filter((reading): reading is NonNullable<typeof reading> => reading !== null);

  return {
    citySlug,
    prices,
    fetchedAt: new Date().toISOString(),
    // Fresh by definition: this snapshot was just assembled, and its presence
    // in Redis under a 1-hour TTL is what freshness means here.
    staleAt: null,
    refreshing: false,
  };
}

/**
 * History, one row per city per fuel per run.
 *
 * The unique key is `(cityId, fuelType, fetchedAt)`, so the timestamp is
 * truncated to the hour: a repeatable hourly job that fires twice — a manual
 * refresh on top of the schedule, a redelivery — must update the hour's row
 * rather than accumulate near-duplicates a chart would render as noise.
 */
async function writeHistory(cityId: string, snapshot: FuelSnapshot, hour: Date): Promise<number> {
  let written = 0;

  for (const reading of snapshot.prices) {
    await prisma.fuelPrice.upsert({
      where: {
        cityId_fuelType_fetchedAt: { cityId, fuelType: reading.fuelType, fetchedAt: hour },
      },
      create: {
        cityId,
        fuelType: reading.fuelType,
        price: reading.price,
        currency: reading.currency,
        source: reading.source,
        sourceUrl: reading.sourceUrl,
        fetchedAt: hour,
      },
      update: {
        price: reading.price,
        source: reading.source,
        sourceUrl: reading.sourceUrl,
      },
    });
    written += 1;
  }

  return written;
}

/**
 * Per-adapter health, carried forward across runs.
 *
 * `consecutiveFailures` is the number that matters and the reason this is
 * stored rather than recomputed: it can only be counted by remembering the
 * previous run. An adapter that has failed three hours running is down, not
 * flaky (`FUEL_ADAPTER_DEAD_AFTER_RUNS`), and with several sources per fuel
 * nothing else on the system would notice.
 */
async function writeHealth(outcomes: FuelAdapterOutcome[], lastRunAt: string): Promise<void> {
  let previous: FuelHealthReport | null = null;
  try {
    const raw = await redis.get(FUEL_HEALTH_KEY);
    if (raw) previous = JSON.parse(raw) as FuelHealthReport;
  } catch {
    // A missing or corrupt previous report costs a counter, not a run.
  }

  const adapters: FuelAdapterHealth[] = FUEL_SOURCES.map((source) => {
    const mine = outcomes.filter((outcome) => outcome.source === source.id);
    const citiesOk = mine
      .filter((outcome) => outcome.ok && outcome.quotes.length > 0)
      .map((outcome) => outcome.citySlug);
    const failures = mine
      .filter((outcome) => !outcome.ok)
      .map((outcome) => ({ citySlug: outcome.citySlug, error: outcome.error ?? 'unknown' }));

    const before = previous?.adapters.find((entry) => entry.source === source.id);
    const succeeded = citiesOk.length > 0;

    return {
      source: source.id,
      label: source.label,
      homepage: source.homepage,
      citiesOk,
      failures,
      lastRunAt,
      lastSuccessAt: succeeded ? lastRunAt : (before?.lastSuccessAt ?? null),
      consecutiveFailures: succeeded ? 0 : (before?.consecutiveFailures ?? 0) + 1,
      averageDurationMs:
        mine.length === 0
          ? 0
          : Math.round(mine.reduce((sum, outcome) => sum + outcome.durationMs, 0) / mine.length),
    };
  });

  const citiesWithoutPrices = CITIES.filter(
    (city) =>
      !outcomes.some(
        (outcome) =>
          outcome.citySlug === city.slug &&
          outcome.quotes.some((quote) => quote.fuelType === city.defaultFuelType),
      ),
  ).map((city) => city.slug);

  const report: FuelHealthReport = { adapters, citiesWithoutPrices, lastRunAt };

  try {
    // No TTL: a health report that expired would read as "healthy, nothing to
    // report" on the admin page, which is the opposite of what an absent
    // report means.
    await redis.set(FUEL_HEALTH_KEY, JSON.stringify(report));
  } catch (error) {
    logger.warn({ err: error }, 'could not store fuel adapter health');
  }

  for (const adapter of adapters) {
    if (adapter.consecutiveFailures >= FUEL_ADAPTER_DEAD_AFTER_RUNS) {
      logger.error(
        {
          source: adapter.source,
          consecutiveFailures: adapter.consecutiveFailures,
          lastSuccessAt: adapter.lastSuccessAt,
        },
        'fuel adapter has failed every run for hours; the redundancy it was providing is gone',
      );
    }
  }

  if (citiesWithoutPrices.length > 0) {
    logger.error(
      { cities: citiesWithoutPrices },
      'no fuel price for a city default fuel; commute cost will fall back to the last stored row',
    );
  }
}

export interface FuelScrapeResult {
  scrapedAt: string;
  adapters: number;
  cities: number;
  quotes: number;
  historyRows: number;
  citiesWithoutPrices: string[];
}

export async function scrapeFuelPrices(
  options: { signal?: AbortSignal } = {},
): Promise<FuelScrapeResult> {
  const startedAt = Date.now();
  const scrapedAt = new Date().toISOString();

  // Truncated to the UTC hour, so a double fire updates rather than duplicates.
  //
  // UTC, not local. `setMinutes(0, 0, 0)` on a machine in IST buckets to 16:00
  // local, which is 10:30 UTC — visible in the first run's history rows, which
  // landed at :30 past. Harmless until the server's timezone changes or a
  // second one joins it, at which point the buckets no longer line up and a
  // chart grows two rows an hour.
  const hour = new Date();
  hour.setUTCMinutes(0, 0, 0);

  const cityIds = new Map(
    (await prisma.city.findMany({ select: { id: true, slug: true } })).map((city) => [
      city.slug,
      city.id,
    ]),
  );

  const allOutcomes: FuelAdapterOutcome[] = [];
  let quoteCount = 0;
  let historyRows = 0;

  // Cities in series, and adapters within a city in series too. Three cities
  // times three sources times three fuels is 27 requests; firing them in
  // parallel would be a burst against somebody else's server for no gain — the
  // job has an hour.
  for (const city of CITIES) {
    const outcomes = await scrapeCity(city, options.signal);
    allOutcomes.push(...outcomes);

    const quotes = outcomes.flatMap((outcome) => outcome.quotes);
    quoteCount += quotes.length;

    if (quotes.length === 0) {
      logger.warn({ citySlug: city.slug }, 'no fuel quotes for city this run; keeping last good');
      continue;
    }

    const snapshot = snapshotFor(city.slug, quotes);

    try {
      await redis.set(
        fuelCacheKey(city.slug),
        JSON.stringify(snapshot),
        'EX',
        CACHE_TTL_SECONDS.fuelPrice,
      );
    } catch (error) {
      // The database write below still happens, so the API's fallback path
      // keeps working. A dead Redis degrades freshness, not availability.
      logger.warn({ err: error, citySlug: city.slug }, 'could not cache fuel snapshot');
    }

    const cityId = cityIds.get(city.slug);
    if (cityId) {
      historyRows += await writeHistory(cityId, snapshot, hour);
    } else {
      logger.warn({ citySlug: city.slug }, 'city is configured but not seeded; no history written');
    }

    logger.info(
      {
        citySlug: city.slug,
        fuels: snapshot.prices.map((price) => `${price.fuelType}=${String(price.price)}`),
        sources: [...new Set(quotes.map((quote) => quote.source))],
      },
      'fuel prices refreshed',
    );
  }

  await writeHealth(allOutcomes, scrapedAt);

  const citiesWithoutPrices = CITIES.filter(
    (city) => !allOutcomes.some((o) => o.citySlug === city.slug && o.quotes.length > 0),
  ).map((city) => city.slug);

  const result: FuelScrapeResult = {
    scrapedAt,
    adapters: FUEL_ADAPTERS.length,
    cities: CITIES.length,
    quotes: quoteCount,
    historyRows,
    citiesWithoutPrices,
  };

  logger.info({ ...result, durationMs: Date.now() - startedAt }, 'fuel scrape finished');
  return result;
}
