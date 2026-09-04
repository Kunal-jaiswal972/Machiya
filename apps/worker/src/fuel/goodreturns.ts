import type { FuelQuote, FuelType } from '@machiya/shared';
import { fuelSourceById, type CityConfig } from '@machiya/shared/cities';
import { buildQuote, cityNameVariants, priceNearCity, type FuelAdapter } from './adapter.js';
import { fetchPage } from './fetch-page.js';

/**
 * GoodReturns — the only one of the three sources that publishes CNG per city.
 *
 * **Anchored on schema.org structured data, not on markup.** The page carries a
 * `WebPage` blob whose `name` and `description` both spell out the city and the
 * price:
 *
 *     "Petrol Price in Patna, Petrol Rate Today (4th Sep, 2026), Rs. 113.37/Ltr"
 *     "Today's Patna Petrol Price is Rs. 113.37 per litre, ..."
 *
 * That is machine-readable by design and survives a redesign; a `div` class
 * does not.
 *
 * **The trap this adapter exists to avoid.** The page ALSO has a wealth ticker
 * in its header carrying the *national* prices — petrol 111.31, diesel 97.97,
 * and an LPG cylinder at 941.50 — while Patna's actual petrol price that day
 * was 113.37. A parser that took the first rupee figure on the page would
 * return 111.31: a completely plausible fuel price, for the wrong place, with
 * nothing to distinguish it from a correct answer. Every pattern below
 * therefore requires the city name adjacent to the number.
 */
const PATHS: Record<FuelType, (slug: string) => string> = {
  PETROL: (slug) => `/petrol-price-in-${slug}.html`,
  DIESEL: (slug) => `/diesel-price-in-${slug}.html`,
  CNG: (slug) => `/cng-price-in-${slug}.html`,
};

const FUEL_WORD: Record<FuelType, string> = {
  PETROL: 'Petrol',
  DIESEL: 'Diesel',
  CNG: 'CNG',
};

const source = fuelSourceById('goodreturns');

export const goodreturnsAdapter: FuelAdapter = {
  source: source ?? {
    id: 'goodreturns',
    label: 'GoodReturns',
    homepage: 'https://www.goodreturns.in',
    fuels: ['PETROL', 'DIESEL', 'CNG'],
  },

  async fetchCity({ city, slug, signal }): Promise<FuelQuote[]> {
    const quotes: FuelQuote[] = [];
    const fetchedAt = new Date().toISOString();

    for (const fuelType of this.source.fuels) {
      const url = `${this.source.homepage}${PATHS[fuelType](slug)}`;

      let html: string;
      try {
        html = await fetchPage(url, { ...(signal ? { signal } : {}) });
      } catch {
        // One fuel's page 404ing is not this source failing. Petrol and diesel
        // still count, and the job reports what it got.
        continue;
      }

      const price = priceNearCity(html, patternsFor(city, fuelType));
      if (price === null) continue;

      const quote = buildQuote({
        city,
        source: this.source,
        fuelType,
        price,
        sourceUrl: url,
        fetchedAt,
      });
      if (quote) quotes.push(quote);
    }

    return quotes;
  },
};

/**
 * Patterns from most to least specific, all requiring the city name.
 *
 * The order is the fallback chain: structured data first, then the FAQ answer
 * (which is also generated text and just as reliable), then a bounded window
 * around a city mention. There is deliberately no final "any number" pattern.
 */
function patternsFor(city: CityConfig, fuelType: FuelType): RegExp[] {
  const fuel = FUEL_WORD[fuelType];
  const patterns: RegExp[] = [];

  for (const name of cityNameVariants(city)) {
    const n = escape(name);
    patterns.push(
      // "Today's Patna Petrol Price is Rs. 113.37 per litre"
      new RegExp(`${n}\\s+${fuel}\\s+Price is Rs\\.?\\s*([\\d,]+\\.\\d{1,2})`, 'i'),
      // "Petrol Price in Patna, Petrol Rate Today (...), Rs. 113.37/Ltr"
      new RegExp(`${fuel} Price in ${n}[^"]{0,120}?Rs\\.?\\s*([\\d,]+\\.\\d{1,2})`, 'i'),
      // FAQ: "the price of 1 litre of petrol in Patna is ₹113.37 per litre"
      new RegExp(`${fuel} in ${n} is\\s*(?:₹|Rs\\.?)\\s*([\\d,]+\\.\\d{1,2})`, 'i'),
      // Last resort, still city-anchored and tightly bounded.
      new RegExp(`${n}[^<>{}]{0,80}?(?:₹|Rs\\.?)\\s*([\\d,]+\\.\\d{1,2})`, 'i'),
    );
  }

  return patterns;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
