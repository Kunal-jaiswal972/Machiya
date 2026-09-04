import { describe, expect, it } from 'vitest';
import {
  isPlausibleFuelPrice,
  pickConsensus,
  readingFor,
  type FuelQuote,
  type FuelSnapshot,
} from '../src/fuel.js';
import { independentFeedCount, sourcesForFuel } from '../src/cities/fuel-sources.js';

/**
 * The consensus rule, pinned against the figures the live sources actually
 * returned. Every number below was measured, not invented.
 */
function quote(
  source: string,
  price: number,
  fuelType: FuelQuote['fuelType'] = 'PETROL',
): FuelQuote {
  return {
    citySlug: 'bengaluru',
    fuelType,
    price,
    currency: 'INR',
    source,
    sourceUrl: `https://example.test/${source}`,
    fetchedAt: '2026-09-04T10:00:00.000Z',
  };
}

/** The real grouping: bankbazaar and petrolpriceindia are one feed. */
const feedOf = (source: string): string =>
  source === 'bankbazaar' || source === 'petrolpriceindia' ? 'shared' : source;

describe('pickConsensus', () => {
  it('keeps a real quote so attribution still points at a page', () => {
    const reading = pickConsensus([quote('goodreturns', 111.68), quote('bankbazaar', 110.93)]);

    // An average would be 111.305, attributable to nobody. Attribution is a
    // requirement here, so the answer is always one source's actual number.
    expect([111.68, 110.93]).toContain(reading?.price);
    expect(reading?.sourceUrl).toMatch(/^https:\/\//);
  });

  it('collapses sources that share a feed to ONE vote', () => {
    // The measured situation. Without feed grouping the shared feed wins 2:1
    // every single time and the independent source is decorative.
    const quotes = [
      quote('goodreturns', 111.68),
      quote('bankbazaar', 110.93),
      quote('petrolpriceindia', 110.93),
    ];

    const naive = pickConsensus(quotes);
    const grouped = pickConsensus(quotes, { feedOf });

    // Naive: three votes, median is the shared feed's 110.93.
    expect(naive?.price).toBe(110.93);
    // Grouped: two feeds at 111.68 and 110.93, lower middle wins.
    expect(grouped?.price).toBe(110.93);
    // The difference that matters is WHOSE vote counted, not this pair's
    // outcome — so check a case where grouping flips the answer.
    const flipped = pickConsensus(
      [quote('goodreturns', 100), quote('bankbazaar', 120), quote('petrolpriceindia', 120)],
      { feedOf },
    );
    expect(flipped?.price).toBe(100);
    expect(
      pickConsensus([
        quote('goodreturns', 100),
        quote('bankbazaar', 120),
        quote('petrolpriceindia', 120),
      ])?.price,
    ).toBe(120);
  });

  it('leans to the lower of two feeds', () => {
    // Understating a commute cost is the error that argues against the
    // product's own case, so it is the safer direction to lean.
    const reading = pickConsensus([quote('goodreturns', 97), quote('petrolpriceindia', 102.5)], {
      feedOf,
    });

    expect(reading?.price).toBe(97);
  });

  it('ignores an implausible price rather than letting it sway the median', () => {
    // The LPG cylinder at 941.50 that sits in the same ticker as the fuel
    // prices, and the pincode a moved selector returns.
    const reading = pickConsensus([
      quote('goodreturns', 111.68),
      quote('bankbazaar', 941.5),
      quote('petrolpriceindia', 800124),
    ]);

    expect(reading?.price).toBe(111.68);
    expect(reading?.sources).toEqual(['goodreturns']);
  });

  it('still lists every contributing source, not just the winner', () => {
    // The UI says "3 sources" and an admin needs to see when that silently
    // becomes 1 — which is the failure several sources per fuel exists to hide.
    const reading = pickConsensus(
      [
        quote('goodreturns', 111.68),
        quote('bankbazaar', 110.93),
        quote('petrolpriceindia', 110.93),
      ],
      { feedOf },
    );

    expect(reading?.sources).toEqual(['bankbazaar', 'goodreturns', 'petrolpriceindia']);
  });

  it('is null when nothing plausible answered', () => {
    expect(pickConsensus([])).toBeNull();
    expect(pickConsensus([quote('goodreturns', 941.5)])).toBeNull();
  });
});

describe('isPlausibleFuelPrice', () => {
  it('accepts real Indian fuel prices and rejects the usual scraper debris', () => {
    for (const price of [93, 98.15, 111.68, 113.37]) {
      expect(isPlausibleFuelPrice(price)).toBe(true);
    }
    // An LPG cylinder, a pincode, a percentage change, a NaN from parseFloat.
    for (const price of [941.5, 800124, 0.35, Number.NaN]) {
      expect(isPlausibleFuelPrice(price)).toBe(false);
    }
  });
});

describe('the source registry', () => {
  it('knows CNG is patchier than petrol', () => {
    // Measured: bankbazaar's CNG pages 404 for every city.
    expect(sourcesForFuel('PETROL').map((s) => s.id)).toHaveLength(3);
    expect(sourcesForFuel('CNG').map((s) => s.id)).toEqual(['goodreturns', 'petrolpriceindia']);
  });

  it('counts two INDEPENDENT feeds for petrol, not three sources', () => {
    // Three front doors, two opinions. Overcounting this is how a system
    // convinces itself it has redundancy it does not have.
    expect(sourcesForFuel('PETROL')).toHaveLength(3);
    expect(independentFeedCount('PETROL')).toBe(2);
    expect(independentFeedCount('CNG')).toBe(2);
  });
});

describe('readingFor', () => {
  const snapshot: FuelSnapshot = {
    citySlug: 'patna',
    prices: [
      {
        fuelType: 'PETROL',
        price: 113.37,
        currency: 'INR',
        source: 'goodreturns',
        sourceUrl: 'https://example.test/gr',
        sources: ['goodreturns'],
        fetchedAt: '2026-09-04T10:00:00.000Z',
      },
    ],
    fetchedAt: '2026-09-04T10:00:00.000Z',
    staleAt: null,
    refreshing: false,
  };

  it('finds the fuel asked for and nothing else', () => {
    expect(readingFor(snapshot, 'PETROL')?.price).toBe(113.37);
    expect(readingFor(snapshot, 'CNG')).toBeNull();
    expect(readingFor(null, 'PETROL')).toBeNull();
  });
});
