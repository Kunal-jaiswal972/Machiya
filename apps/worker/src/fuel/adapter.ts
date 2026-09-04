import {
  isPlausibleFuelPrice,
  type FuelAdapterOutcome,
  type FuelQuote,
  type FuelType,
} from '@machiya/shared';
import type { CityConfig, FuelSource, FuelSourceFuel } from '@machiya/shared/cities';
import { RobotsDisallowedError } from './fetch-page.js';
import { logger } from '../logger.js';

/**
 * What every fuel adapter is, and the guard rails they all inherit.
 *
 * One file per source under this directory, each exporting a `FuelAdapter`.
 * Adding a source is a file plus a registry entry — no call site changes —
 * which is the same shape as the geo providers and for the same reason.
 */
export interface FuelAdapter {
  readonly source: FuelSource;
  /**
   * Fetch what this source publishes for one city.
   *
   * May return fewer fuels than it advertises: a page can 404 for CNG and
   * answer for petrol, and that is partial success rather than failure. Throw
   * only when nothing could be fetched at all.
   */
  fetchCity(input: { city: CityConfig; slug: string; signal?: AbortSignal }): Promise<FuelQuote[]>;
}

/**
 * The names a page might use for a city, so a quote can be checked against the
 * page that produced it.
 *
 * **This is the most important function in the fuel pipeline.** Two of the
 * originally configured sources answered HTTP 200 with a different city's
 * price: mypetrolprice serves the Delhi shell for every city slug, and a
 * ticker on goodreturns' Patna page carries the *national* petrol figure
 * (111.31) next to Patna's real one (113.37). Neither is catchable by a
 * plausibility band — both are perfectly plausible fuel prices — so the only
 * defence is refusing a number the page does not itself attach to this city.
 *
 * Bengaluru needs both spellings because every source indexes it as Bangalore
 * while the page text sometimes says Bengaluru.
 */
export function cityNameVariants(city: CityConfig): string[] {
  const variants = new Set<string>([city.name]);

  if (city.slug === 'bengaluru') {
    variants.add('Bangalore');
    variants.add('Bengaluru');
  }

  return [...variants];
}

/**
 * Builds a quote, refusing anything the source has not earned.
 *
 * Three refusals, each for a failure seen live rather than imagined:
 *  - a price outside the plausibility band (a pincode, a percentage change, an
 *    LPG cylinder at 941.50 sitting in the same ticker);
 *  - a fuel the source does not claim to publish, which would mean the parser
 *    matched the wrong section;
 *  - anything at all when the page never named this city.
 */
export function buildQuote(input: {
  city: CityConfig;
  source: FuelSource;
  fuelType: FuelType;
  price: number;
  sourceUrl: string;
  fetchedAt: string;
}): FuelQuote | null {
  const { city, source, fuelType, price, sourceUrl } = input;

  if (!isPlausibleFuelPrice(price)) {
    logger.warn(
      { source: source.id, citySlug: city.slug, fuelType, price },
      'fuel quote rejected: price outside the plausible band',
    );
    return null;
  }

  if (!source.fuels.includes(fuelType as FuelSourceFuel)) {
    logger.warn(
      { source: source.id, citySlug: city.slug, fuelType },
      'fuel quote rejected: source does not publish this fuel, so the parser matched the wrong thing',
    );
    return null;
  }

  return {
    citySlug: city.slug,
    fuelType,
    price,
    currency: 'INR',
    source: source.id,
    sourceUrl,
    fetchedAt: input.fetchedAt,
  };
}

/**
 * Finds a price the page itself associates with this city.
 *
 * Every adapter's parser goes through here rather than matching a bare number.
 * `patterns` are built per source from the city name — see the adapters — and
 * the first that matches wins, so a source can declare a precise anchor and
 * fall back to a looser one without ever falling back to "any number".
 */
export function priceNearCity(html: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    const raw = match?.[1];
    if (raw === undefined) continue;

    const price = Number.parseFloat(raw.replace(/,/g, ''));
    if (Number.isFinite(price)) return price;
  }

  return null;
}

/**
 * Runs one adapter for one city and turns every possible ending into an
 * outcome.
 *
 * Nothing throws out of here. A dead source is the **normal case** for this
 * pipeline — these sites reshuffle their markup and sit behind edges that
 * refuse unknown agents — so the job needs a value per attempt to report,
 * never an exception to handle.
 */
export async function runAdapter(input: {
  adapter: FuelAdapter;
  city: CityConfig;
  signal?: AbortSignal;
}): Promise<FuelAdapterOutcome> {
  const { adapter, city } = input;
  const startedAt = Date.now();
  const slug = city.fuelSlugs[adapter.source.id as keyof typeof city.fuelSlugs];

  const base = { source: adapter.source.id, citySlug: city.slug };

  if (!slug) {
    // `validate-cities.ts` fails CI for this, so reaching it means the
    // validator was bypassed. Loud, and not a crash.
    return {
      ...base,
      ok: false,
      quotes: [],
      error: `no ${adapter.source.id} slug configured for ${city.slug}`,
      durationMs: Date.now() - startedAt,
      disallowed: false,
    };
  }

  try {
    const quotes = await adapter.fetchCity({
      city,
      slug,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    return {
      ...base,
      // Zero quotes is still `ok`: the source answered, and what it publishes
      // for this city is nothing. `ok: false` is reserved for "we could not
      // ask", which is a different thing to put on a health page.
      ok: true,
      quotes,
      durationMs: Date.now() - startedAt,
      disallowed: false,
    };
  } catch (error) {
    const disallowed = error instanceof RobotsDisallowedError;
    const message = error instanceof Error ? error.message : 'unknown failure';

    logger.warn({ ...base, err: message, disallowed }, 'fuel adapter failed');

    return {
      ...base,
      ok: false,
      quotes: [],
      error: message,
      durationMs: Date.now() - startedAt,
      disallowed,
    };
  }
}
