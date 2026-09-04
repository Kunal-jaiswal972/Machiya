import { prisma } from '@machiya/db';
import { fuelCacheKey } from '@machiya/shared';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The rule this suite exists to defend: **a request never blocks on a scrape.**
 *
 * A scrape walks three websites and takes seconds when it works. So a cache
 * miss must serve the last stored rows immediately, say how old they are, and
 * enqueue a refresh in the background — and the enqueue must not be able to
 * fail the read either.
 */
const enqueued: string[] = [];
let enqueueThrows = false;

vi.mock('../src/lib/queues.js', () => ({
  enqueueFuelRefresh: async (citySlug: string) => {
    if (enqueueThrows) throw new Error('queue unreachable');
    enqueued.push(citySlug);
  },
  enqueueImageProcessing: async () => undefined,
  closeQueues: async () => undefined,
  QUEUE_NAMES: { images: 'images', fuelPrices: 'fuel-prices' },
}));

const cached = new Map<string, unknown>();

vi.mock('../src/lib/cache.js', () => ({
  cacheGet: async (key: string) => cached.get(key) ?? null,
  cacheSet: async () => undefined,
  cached: async () => ({ value: null, hit: false, stale: false }),
  normalizeQueryKey: (q: string) => q.trim().toLowerCase(),
}));

const { getFuelPrice, getFuelSnapshot } = await import('../src/services/fuel.js');

let cityId: string;

beforeEach(async () => {
  enqueued.length = 0;
  enqueueThrows = false;
  cached.clear();

  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "ListingAmenity", "ListingImage", "ListingView", "Favorite",
      "EnquiryMessage", "Enquiry", "SavedSearch", "FuelPrice", "CoverageRequest",
      "Listing", "OfficeLocation", "Amenity", "Locality", "Session", "Account",
      "User", "City" RESTART IDENTITY CASCADE
  `);

  const city = await prisma.city.create({
    data: {
      slug: 'patna',
      name: 'Patna',
      state: 'Bihar',
      centroidLat: 25.5941,
      centroidLng: 85.1376,
      bbox: { minLng: 84.95, minLat: 25.5, maxLng: 85.3, maxLat: 25.68 },
      defaultFuelType: 'PETROL',
    },
    select: { id: true },
  });
  cityId = city.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function storePrice(input: {
  fuelType: 'PETROL' | 'DIESEL' | 'CNG';
  price: number;
  hoursAgo: number;
  source?: string;
}): Promise<void> {
  const fetchedAt = new Date(Date.now() - input.hoursAgo * 3_600_000);
  fetchedAt.setUTCMinutes(0, 0, 0);

  await prisma.fuelPrice.create({
    data: {
      cityId,
      fuelType: input.fuelType,
      price: input.price,
      source: input.source ?? 'goodreturns',
      sourceUrl: 'https://www.goodreturns.in/petrol-price-in-patna.html',
      fetchedAt,
    },
  });
}

describe('a cache hit is fresh by definition', () => {
  it('serves the Redis snapshot with no staleAt and no refresh', async () => {
    cached.set(fuelCacheKey('patna'), {
      citySlug: 'patna',
      prices: [
        {
          fuelType: 'PETROL',
          price: 113.37,
          currency: 'INR',
          source: 'goodreturns',
          sourceUrl: 'https://www.goodreturns.in/petrol-price-in-patna.html',
          sources: ['goodreturns'],
          fetchedAt: new Date().toISOString(),
        },
      ],
      fetchedAt: new Date().toISOString(),
      staleAt: null,
      refreshing: false,
    });

    const snapshot = await getFuelSnapshot('patna');

    expect(snapshot?.prices[0]?.price).toBe(113.37);
    // The Redis copy has a 1-hour TTL, so its presence IS its freshness.
    expect(snapshot?.staleAt).toBeNull();
    expect(snapshot?.refreshing).toBe(false);
    expect(enqueued).toEqual([]);
  });
});

describe('a cache miss serves the database and says how old it is', () => {
  it('answers immediately with staleAt set and a refresh enqueued', async () => {
    await storePrice({ fuelType: 'PETROL', price: 111.5, hoursAgo: 3 });

    const snapshot = await getFuelSnapshot('patna');

    expect(snapshot?.prices[0]?.price).toBe(111.5);
    // The honest part: the UI can say "prices from 3 hours ago" instead of
    // showing a spinner over a scrape that may take 20 seconds and then fail.
    expect(snapshot?.staleAt).not.toBeNull();
    expect(snapshot?.refreshing).toBe(true);
    expect(enqueued).toEqual(['patna']);
  });

  it('reports the OLDEST reading as staleAt, not the newest', async () => {
    // A fresh petrol row must not make a three-day-old CNG row look current.
    await storePrice({ fuelType: 'PETROL', price: 113.37, hoursAgo: 1 });
    await storePrice({ fuelType: 'CNG', price: 93, hoursAgo: 72 });

    const snapshot = await getFuelSnapshot('patna');
    const staleAt = new Date(snapshot?.staleAt ?? 0).getTime();
    const hoursOld = (Date.now() - staleAt) / 3_600_000;

    expect(hoursOld).toBeGreaterThan(70);
  });

  it('takes the newest row PER FUEL, not the newest rows overall', async () => {
    // Ordering by fetchedAt and taking three rows would drop CNG entirely
    // whenever petrol and diesel had been refreshed more recently.
    await storePrice({ fuelType: 'CNG', price: 93, hoursAgo: 10 });
    await storePrice({ fuelType: 'PETROL', price: 100, hoursAgo: 5 });
    await storePrice({ fuelType: 'PETROL', price: 113.37, hoursAgo: 1 });
    await storePrice({ fuelType: 'DIESEL', price: 99.36, hoursAgo: 1 });

    const snapshot = await getFuelSnapshot('patna');
    const byFuel = Object.fromEntries(
      (snapshot?.prices ?? []).map((price) => [price.fuelType, price.price]),
    );

    expect(byFuel).toEqual({ PETROL: 113.37, DIESEL: 99.36, CNG: 93 });
  });

  it('still serves the read when the queue is down', async () => {
    // The enqueue is fire-and-forget precisely so a dead queue costs freshness
    // rather than the answer.
    enqueueThrows = true;
    await storePrice({ fuelType: 'PETROL', price: 111.5, hoursAgo: 2 });

    const snapshot = await getFuelSnapshot('patna');

    expect(snapshot?.prices[0]?.price).toBe(111.5);
  });

  it('ignores a cached blob whose shape has drifted', async () => {
    // The shape is what the cost engine reads, so an older blob must fall
    // through to the database rather than be served.
    cached.set(fuelCacheKey('patna'), { citySlug: 'patna', prices: 'not an array' });
    await storePrice({ fuelType: 'PETROL', price: 111.5, hoursAgo: 2 });

    const snapshot = await getFuelSnapshot('patna');

    expect(snapshot?.prices[0]?.price).toBe(111.5);
    expect(snapshot?.refreshing).toBe(true);
  });
});

describe('nothing at all', () => {
  it('is null rather than an empty snapshot', async () => {
    // "We have no price" is different from "fuel is free here", and a zero
    // would flow into a commute cost looking like an answer.
    expect(await getFuelSnapshot('patna')).toBeNull();
  });

  it('is null for a city that does not exist', async () => {
    expect(await getFuelSnapshot('mumbai')).toBeNull();
  });
});

describe('getFuelPrice', () => {
  it('falls back to the city default fuel when the requested one is missing', async () => {
    // CNG coverage is genuinely patchy across every source.
    await storePrice({ fuelType: 'PETROL', price: 113.37, hoursAgo: 1 });

    const reading = await getFuelPrice('patna', 'CNG');

    expect(reading?.price).toBe(113.37);
    // And says which fuel it actually priced, so the panel does not label a
    // petrol figure as CNG.
    expect(reading?.fuelType).toBe('PETROL');
  });

  it('is null when neither the requested fuel nor the default is available', async () => {
    await storePrice({ fuelType: 'DIESEL', price: 99.36, hoursAgo: 1 });

    expect(await getFuelPrice('patna', 'CNG')).toBeNull();
  });
});
