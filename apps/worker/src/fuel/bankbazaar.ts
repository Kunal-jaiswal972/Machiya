import type { FuelQuote, FuelType } from '@machiya/shared';
import { fuelSourceById, type CityConfig } from '@machiya/shared/cities';
import { buildQuote, cityNameVariants, priceNearCity, type FuelAdapter } from './adapter.js';
import { fetchPage } from './fetch-page.js';

/**
 * BankBazaar — petrol and diesel only. Its CNG pages 404 for every city, so
 * the registry does not claim CNG for it and this adapter never asks.
 *
 * Anchored on the page's own heading, which names the city and the fuel:
 *
 *     <h2 ...>Today&#x27;s Petrol Price in Patna</h2> ... <span ...>₹ 113.37</span>
 *
 * Note the HTML-escaped apostrophe. The pattern skips over it rather than
 * trying to match it, because whether a site escapes `'` is exactly the kind of
 * detail that changes without warning.
 *
 * Shares an upstream feed with `petrolpriceindia` — both returned Bengaluru
 * diesel at 98.8 while GoodReturns said 99.56 — so the two together are one
 * opinion with two front doors. Recorded in the registry as `sharesFeedWith`
 * so the redundancy is not overcounted.
 */
const PATHS: Record<'PETROL' | 'DIESEL', (slug: string) => string> = {
  PETROL: (slug) => `/fuel/petrol-price-${slug}.html`,
  DIESEL: (slug) => `/fuel/diesel-price-${slug}.html`,
};

const FUEL_WORD = { PETROL: 'Petrol', DIESEL: 'Diesel' } as const;

const source = fuelSourceById('bankbazaar');

export const bankbazaarAdapter: FuelAdapter = {
  source: source ?? {
    id: 'bankbazaar',
    label: 'BankBazaar',
    homepage: 'https://www.bankbazaar.com',
    fuels: ['PETROL', 'DIESEL'],
    sharesFeedWith: ['petrolpriceindia'],
  },

  async fetchCity({ city, slug, signal }): Promise<FuelQuote[]> {
    const quotes: FuelQuote[] = [];
    const fetchedAt = new Date().toISOString();

    for (const fuelType of this.source.fuels) {
      if (fuelType === 'CNG') continue;
      const url = `${this.source.homepage}${PATHS[fuelType](slug)}`;

      let html: string;
      try {
        html = await fetchPage(url, { ...(signal ? { signal } : {}) });
      } catch {
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

function patternsFor(city: CityConfig, fuelType: FuelType): RegExp[] {
  const fuel = FUEL_WORD[fuelType as 'PETROL' | 'DIESEL'];
  const patterns: RegExp[] = [];

  for (const name of cityNameVariants(city)) {
    const n = escape(name);
    patterns.push(
      // The heading, then the first rupee figure after it. The window is
      // bounded so a match cannot reach into the next section's table.
      new RegExp(`${fuel} Price in ${n}\\s*</h\\d>[\\s\\S]{0,400}?₹\\s*([\\d,]+\\.\\d{1,2})`, 'i'),
      // Some pages phrase it as a rate rather than a price.
      new RegExp(`${fuel} Rate in ${n}[\\s\\S]{0,400}?₹\\s*([\\d,]+\\.\\d{1,2})`, 'i'),
      new RegExp(`${n}[^<>{}]{0,80}?₹\\s*([\\d,]+\\.\\d{1,2})`, 'i'),
    );
  }

  return patterns;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
