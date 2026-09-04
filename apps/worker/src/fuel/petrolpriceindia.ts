import type { FuelQuote, FuelType } from '@machiya/shared';
import { fuelSourceById, type CityConfig } from '@machiya/shared/cities';
import { buildQuote, cityNameVariants, priceNearCity, type FuelAdapter } from './adapter.js';
import { fetchPage } from './fetch-page.js';

/**
 * Petrol Price India — petrol, diesel and CNG.
 *
 * Its `<title>` is the anchor, and it is unusually good: "Diesel Price in
 * Bengaluru Today (4 Sept 2026) — ₹98.8/Litre" carries the city, the fuel, the
 * date and the price in one string the site generates itself.
 *
 * Two things about this source are worth knowing before trusting it:
 *
 *  - **It shares an upstream feed with BankBazaar.** Both returned Bengaluru
 *    diesel at exactly 98.8 while GoodReturns said 99.56. So it buys
 *    availability — either site can be down alone — but not a second opinion,
 *    and the registry records that with `sharesFeedWith` so a median across
 *    "three sources" is not mistaken for a consensus of three.
 *  - **Its robots.txt uses Cloudflare content signals**:
 *    `Content-Signal: search=yes,ai-train=no,use=reference` with `Allow: /` for
 *    `*`, and `Disallow: /api/`. `use=reference` is exactly what a cited price
 *    with a link back to the page is, and nothing here trains on the content.
 *    The named-agent blocks below it (GPTBot, ClaudeBot, CCBot…) address
 *    crawlers this is not. The `/api/` disallow is honoured by the shared
 *    robots parser rather than by this file remembering it.
 */
const PATHS: Record<FuelType, (slug: string) => string> = {
  PETROL: (slug) => `/petrol-price-in-${slug}`,
  DIESEL: (slug) => `/diesel-price-in-${slug}`,
  CNG: (slug) => `/cng-price-in-${slug}`,
};

const FUEL_WORD: Record<FuelType, string> = {
  PETROL: 'Petrol',
  DIESEL: 'Diesel',
  CNG: 'CNG',
};

const source = fuelSourceById('petrolpriceindia');

export const petrolPriceIndiaAdapter: FuelAdapter = {
  source: source ?? {
    id: 'petrolpriceindia',
    label: 'Petrol Price India',
    homepage: 'https://www.petrolpriceindia.com',
    fuels: ['PETROL', 'DIESEL', 'CNG'],
    sharesFeedWith: ['bankbazaar'],
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
  const fuel = FUEL_WORD[fuelType];
  const patterns: RegExp[] = [];

  for (const name of cityNameVariants(city)) {
    const n = escape(name);
    patterns.push(
      // The title: "Diesel Price in Bengaluru Today (4 Sept 2026) — ₹98.8/Litre"
      new RegExp(
        `${fuel} Price in ${n}[^<]{0,80}?₹\\s*([\\d,]+\\.?\\d{0,2})\\s*/?\\s*(?:Litre|Ltr|Kg)`,
        'i',
      ),
      new RegExp(`${fuel} Price in ${n}[^<]{0,80}?₹\\s*([\\d,]+\\.\\d{1,2})`, 'i'),
      new RegExp(`${n}[^<>{}]{0,80}?₹\\s*([\\d,]+\\.\\d{1,2})`, 'i'),
    );
  }

  return patterns;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
