/**
 * Fuel prices: the contract every scraper normalises to, and the snapshot the
 * API serves.
 *
 * The shape is here rather than in the worker because four things have to agree
 * about it — the adapters that produce it, the job that stores it, the endpoint
 * that serves it and the panel that renders it — and a fuel price that means
 * something different at either end of that chain would be invisible until a
 * commute cost looked wrong.
 *
 * The adapters themselves live in `apps/worker/src/fuel/`, one file per source.
 * The source registry (ids, labels, per-city slugs) is in
 * `@machiya/shared/cities` with the city config, because the validator has to
 * fail CI when a configured city has no slug for a configured source.
 *
 * **Source failure is the normal case, not the exception.** Indian fuel-price
 * sites are unstable, reshuffle their markup and sometimes block scrapers
 * outright, which is why there are several per fuel type and why every shape
 * here can express partial success.
 */
import { z } from 'zod';
import { fuelTypeSchema } from './enums.js';

/**
 * One price, from one source, for one city and fuel.
 *
 * `sourceUrl` is the exact page the number came off, not the site root:
 * attribution has to be checkable, and "goodreturns.in" is not checkable.
 */
export const fuelQuoteSchema = z.object({
  citySlug: z.string().min(1),
  fuelType: fuelTypeSchema,
  /** Rupees per litre, or per kg for CNG. */
  price: z.number().positive().max(1000),
  currency: z.string().default('INR'),
  /** A `FuelSourceId` — kept loose here so this module stays config-free. */
  source: z.string().min(1),
  sourceUrl: z.string().url(),
  fetchedAt: z.string(),
});

export type FuelQuote = z.infer<typeof fuelQuoteSchema>;

/**
 * A sanity band on a scraped number.
 *
 * The failure this catches is the one a scraper produces most often and most
 * quietly: markup moves, the selector matches a different cell, and the price
 * becomes a pincode or a percentage change. `107.24` is a fuel price; `800124`
 * and `0.35` are a bug that would otherwise flow into a commute cost and look
 * like an answer.
 */
export const FUEL_PRICE_BOUNDS = { min: 20, max: 400 } as const;

export function isPlausibleFuelPrice(price: number): boolean {
  return Number.isFinite(price) && price >= FUEL_PRICE_BOUNDS.min && price <= FUEL_PRICE_BOUNDS.max;
}

/**
 * What one adapter returned for one city, including the ways it can fail.
 *
 * `quotes` can be empty with `ok: true` — a source that publishes petrol and
 * diesel but not CNG succeeded at what it does. `ok: false` is a fetch or parse
 * failure, and carries the reason so the admin health page can name it.
 */
export const fuelAdapterOutcomeSchema = z.object({
  source: z.string().min(1),
  citySlug: z.string().min(1),
  ok: z.boolean(),
  quotes: z.array(fuelQuoteSchema),
  /** Present only when `ok` is false. Human-readable, shown to an admin. */
  error: z.string().optional(),
  /** How long the attempt took, so a slow source is visible before it dies. */
  durationMs: z.number().nonnegative(),
  /** True when robots.txt disallowed the path and nothing was fetched. */
  disallowed: z.boolean().default(false),
});

export type FuelAdapterOutcome = z.infer<typeof fuelAdapterOutcomeSchema>;

// --- what the API serves ----------------------------------------------------

/**
 * The agreed price for one fuel in one city, and where it came from.
 *
 * `sources` lists every source that agreed enough to be counted, so the UI can
 * say "3 sources" and an admin can see when it silently becomes 1.
 */
export const fuelPriceSchema = z.object({
  fuelType: fuelTypeSchema,
  price: z.number().positive(),
  currency: z.string(),
  /** The source the served number actually came from. See `pickConsensus`. */
  source: z.string().min(1),
  sourceUrl: z.string().url(),
  /** Every source that contributed a plausible quote this round. */
  sources: z.array(z.string().min(1)),
  fetchedAt: z.string(),
});

export type FuelPriceReading = z.infer<typeof fuelPriceSchema>;

/**
 * Everything the API knows about one city's fuel, and how fresh it is.
 *
 * `staleAt` is the honest part. The API reads Redis only and never blocks on a
 * scrape, so a cache miss serves the most recent database row and says when it
 * stopped being current. "Prices from 3 hours ago" is useful; a spinner waiting
 * on a scrape that may take 20 seconds and then fail is not.
 */
export const fuelSnapshotSchema = z.object({
  citySlug: z.string().min(1),
  prices: z.array(fuelPriceSchema),
  /** When this snapshot was assembled. */
  fetchedAt: z.string(),
  /**
   * When it stopped being fresh, or null while it still is.
   *
   * Set when the snapshot came from Postgres rather than Redis — the Redis copy
   * has a 1-hour TTL, so its presence IS its freshness, and a row from the
   * history table is by definition older than that.
   */
  staleAt: z.string().nullable(),
  /**
   * True when this came from the database because Redis had nothing, and a
   * refresh has been enqueued. Not an error — the request was served.
   */
  refreshing: z.boolean().default(false),
});

export type FuelSnapshot = z.infer<typeof fuelSnapshotSchema>;

/** Redis key for a city's live prices. TTL is `CACHE_TTL_SECONDS.fuelPrice`. */
export function fuelCacheKey(citySlug: string): string {
  return `fuel:${citySlug}`;
}

/**
 * NOT epoch-prefixed, and that is deliberate.
 *
 * `geoCacheKey` exists for things derived from the OSM artifacts — routes, POIs,
 * geocodes — where a rebuild changes the answer. A fuel price has nothing to do
 * with the road graph, and prefixing it would throw away every city's prices on
 * an unrelated rebuild and leave the panel empty until the next hourly scrape.
 * Same reasoning as the view-dedupe key in D46.
 */
export const FUEL_KEY_IS_NOT_EPOCH_SCOPED = true;

// --- consensus --------------------------------------------------------------

/**
 * Which price to believe when several sources disagree.
 *
 * The **median**, and specifically an actual quote rather than an average of
 * them, so `source` and `sourceUrl` still point at a page a user can open. An
 * average of three numbers is attributable to nobody, and attribution is a
 * requirement here rather than a nicety.
 *
 * Median rather than first-wins because the interesting failure with several
 * sources is one adapter silently returning a stale or misparsed number while
 * the others are right — first-wins makes that decide the answer whenever the
 * broken source happens to be listed first. With an even count it takes the
 * lower of the two middles: understating a commute cost is the error that
 * argues against the product's own case, so it is the safer direction to lean.
 */
export function pickConsensus(quotes: readonly FuelQuote[]): FuelPriceReading | null {
  const plausible = quotes.filter((quote) => isPlausibleFuelPrice(quote.price));
  if (plausible.length === 0) return null;

  const sorted = [...plausible].sort((a, b) => a.price - b.price);
  const middle = sorted[Math.floor((sorted.length - 1) / 2)];
  if (!middle) return null;

  return {
    fuelType: middle.fuelType,
    price: middle.price,
    currency: middle.currency,
    source: middle.source,
    sourceUrl: middle.sourceUrl,
    sources: [...new Set(plausible.map((quote) => quote.source))].sort(),
    fetchedAt: middle.fetchedAt,
  };
}

/** The reading for one fuel type out of a snapshot, or null. */
export function readingFor(
  snapshot: FuelSnapshot | null | undefined,
  fuelType: FuelQuote['fuelType'],
): FuelPriceReading | null {
  return snapshot?.prices.find((price) => price.fuelType === fuelType) ?? null;
}

// --- adapter health ---------------------------------------------------------

/**
 * Per-adapter scrape health, for the admin page.
 *
 * The interesting failure with several sources per fuel type is **one adapter
 * silently dying while the others cover for it**: prices keep flowing, the
 * panel looks fine, and the redundancy that was the whole point is gone. So
 * health is tracked per adapter rather than per run, and a source that has not
 * succeeded in a long time is visible without anyone reading a log.
 */
export const fuelAdapterHealthSchema = z.object({
  source: z.string().min(1),
  label: z.string().min(1),
  homepage: z.string().url(),
  /** Cities it produced at least one plausible quote for, on the last run. */
  citiesOk: z.array(z.string().min(1)),
  /** Cities it failed for, with the reason. */
  failures: z.array(z.object({ citySlug: z.string().min(1), error: z.string() })),
  lastRunAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  /** Consecutive runs with no successful city. Zero means healthy. */
  consecutiveFailures: z.number().int().nonnegative(),
  /** Mean attempt duration on the last run, in ms. */
  averageDurationMs: z.number().nonnegative(),
});

export type FuelAdapterHealth = z.infer<typeof fuelAdapterHealthSchema>;

export const fuelHealthReportSchema = z.object({
  adapters: z.array(fuelAdapterHealthSchema),
  /** Cities with no price at all for their default fuel. The real alarm. */
  citiesWithoutPrices: z.array(z.string().min(1)),
  lastRunAt: z.string().nullable(),
});

export type FuelHealthReport = z.infer<typeof fuelHealthReportSchema>;

export const FUEL_HEALTH_KEY = 'fuel:health';

/**
 * After this many consecutive failed runs, an adapter is treated as down rather
 * than as flaky.
 *
 * Three: at one run an hour that is three hours of one source being quietly
 * absent, which is long enough to rule out a transient 503 and short enough to
 * act on before the redundancy is gone.
 */
export const FUEL_ADAPTER_DEAD_AFTER_RUNS = 3;
