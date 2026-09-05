import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/client.js';
import {
  findSimilarListings,
  searchListingsInRadius,
  searchPlacesLocally,
  straightLineDistanceMeters,
} from '../src/geo-queries.js';
import { PATNA_OFFICE, PUNE_OFFICE, north, seedFixtures, type SeededFixtures } from './fixtures.js';

let fixtures: SeededFixtures;

beforeAll(async () => {
  fixtures = await seedFixtures();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const office = { office: PATNA_OFFICE };

function slugs(listings: Array<{ slug: string }>): string[] {
  return listings.map((listing) => listing.slug);
}

/**
 * Fixtures are positioned with a flat metres-per-degree constant while PostGIS
 * measures on the WGS84 spheroid, so nominal and measured distance differ by
 * about 0.5%. Assert that band rather than an exact figure.
 */
function expectMeters(actual: number | undefined, nominal: number): void {
  expect(actual).toBeDefined();
  expect(actual).toBeGreaterThan(nominal * 0.99);
  expect(actual).toBeLessThan(nominal * 1.01);
}

describe('searchListingsInRadius — radius and rings', () => {
  it('returns only published listings inside the radius', async () => {
    const result = await searchListingsInRadius(office);

    expect(slugs(result.listings).sort()).toEqual([
      'far_rent_villa',
      'mid_rent_3bhk',
      'near_rent_2bhk',
      'near_sale',
    ]);
    // 3.5 km away, and a draft 600 m away.
    expect(slugs(result.listings)).not.toContain('outside_radius');
    expect(slugs(result.listings)).not.toContain('draft_studio');
    // Different city, 1500 km away.
    expect(slugs(result.listings)).not.toContain('pune_rent');
  });

  it('honours a tighter radius', async () => {
    const result = await searchListingsInRadius({ ...office, radiusMeters: 1_000 });
    expect(slugs(result.listings).sort()).toEqual(['near_rent_2bhk', 'near_sale']);
  });

  it('computes straight-line distance from the office', async () => {
    const result = await searchListingsInRadius(office);
    const byslug = new Map(result.listings.map((listing) => [listing.slug, listing]));

    expectMeters(byslug.get('near_rent_2bhk')?.distanceMeters, 500);
    expectMeters(byslug.get('mid_rent_3bhk')?.distanceMeters, 1_500);
    expectMeters(byslug.get('far_rent_villa')?.distanceMeters, 2_500);
  });

  it('assigns the ring server-side from that distance', async () => {
    const result = await searchListingsInRadius(office);
    const byslug = new Map(result.listings.map((listing) => [listing.slug, listing]));

    expect(byslug.get('near_rent_2bhk')?.ring).toBe(1);
    expect(byslug.get('near_sale')?.ring).toBe(1);
    expect(byslug.get('mid_rent_3bhk')?.ring).toBe(2);
    expect(byslug.get('far_rent_villa')?.ring).toBe(3);
  });

  it('reports ring counts for the whole set and a total that matches', async () => {
    const result = await searchListingsInRadius(office);

    expect(result.ringCounts).toEqual({ 1: 2, 2: 1, 3: 1 });
    expect(result.total).toBe(4);
  });

  it('filters by ring without changing the reported ring counts', async () => {
    const result = await searchListingsInRadius({ ...office, filters: { ring: 1 } });

    expect(slugs(result.listings).sort()).toEqual(['near_rent_2bhk', 'near_sale']);
    // Counts still describe every ring, so the UI can label the other options.
    expect(result.ringCounts).toEqual({ 1: 2, 2: 1, 3: 1 });
  });

  it('includes drafts only when the caller asks for them', async () => {
    const result = await searchListingsInRadius({ ...office, statuses: ['DRAFT'] });
    expect(slugs(result.listings)).toEqual(['draft_studio']);
  });
});

describe('searchListingsInRadius — filters', () => {
  it('filters by listing type', async () => {
    const rent = await searchListingsInRadius({ ...office, filters: { listingType: 'RENT' } });
    expect(slugs(rent.listings)).not.toContain('near_sale');

    const sale = await searchListingsInRadius({ ...office, filters: { listingType: 'SALE' } });
    expect(slugs(sale.listings)).toEqual(['near_sale']);
  });

  it('applies a price range to rent for rentals and sale price for sales', async () => {
    const cheapRent = await searchListingsInRadius({
      ...office,
      filters: { listingType: 'RENT', priceMax: 20_000 },
    });
    expect(slugs(cheapRent.listings)).toEqual(['near_rent_2bhk']);

    // The same range must not silently exclude the 75 lakh sale listing by
    // comparing a purchase price against a monthly rent.
    const anySale = await searchListingsInRadius({
      ...office,
      filters: { listingType: 'SALE', priceMin: 5_000_000, priceMax: 9_000_000 },
    });
    expect(slugs(anySale.listings)).toEqual(['near_sale']);
  });

  it('filters by bedrooms, bathrooms and area', async () => {
    const threePlus = await searchListingsInRadius({ ...office, filters: { bedroomsMin: 3 } });
    expect(slugs(threePlus.listings).sort()).toEqual([
      'far_rent_villa',
      'mid_rent_3bhk',
      'near_sale',
    ]);

    const bigBath = await searchListingsInRadius({ ...office, filters: { bathroomsMin: 4 } });
    expect(slugs(bigBath.listings)).toEqual(['far_rent_villa']);

    const compact = await searchListingsInRadius({ ...office, filters: { areaSqftMax: 1_000 } });
    expect(slugs(compact.listings)).toEqual(['near_rent_2bhk']);
  });

  it('filters by furnishing and property type', async () => {
    const furnished = await searchListingsInRadius({
      ...office,
      filters: { furnishing: ['FULLY_FURNISHED'] },
    });
    expect(slugs(furnished.listings)).toEqual(['near_rent_2bhk']);

    const houses = await searchListingsInRadius({
      ...office,
      filters: { propertyType: ['VILLA', 'BUILDER_FLOOR'] },
    });
    expect(slugs(houses.listings).sort()).toEqual(['far_rent_villa', 'mid_rent_3bhk']);
  });

  it('requires ALL selected amenities, not any of them', async () => {
    const lift = await searchListingsInRadius({ ...office, filters: { amenitySlugs: ['lift'] } });
    expect(slugs(lift.listings).sort()).toEqual(['mid_rent_3bhk', 'near_rent_2bhk', 'near_sale']);

    const liftAndParking = await searchListingsInRadius({
      ...office,
      filters: { amenitySlugs: ['lift', 'parking'] },
    });
    expect(slugs(liftAndParking.listings)).toEqual(['near_rent_2bhk']);

    const impossible = await searchListingsInRadius({
      ...office,
      filters: { amenitySlugs: ['lift', 'power-backup'] },
    });
    expect(impossible.listings).toEqual([]);
  });

  it('treats a listing with no availableFrom as available now', async () => {
    const soon = await searchListingsInRadius({
      ...office,
      filters: { availableBy: new Date() },
    });

    // The villa has no availableFrom; the 3BHK is not free until next year.
    expect(slugs(soon.listings)).toContain('far_rent_villa');
    expect(slugs(soon.listings)).toContain('near_rent_2bhk');
    expect(slugs(soon.listings)).not.toContain('mid_rent_3bhk');
  });

  it('filters by verified flag and by city slug', async () => {
    const verified = await searchListingsInRadius({ ...office, filters: { verifiedOnly: true } });
    expect(slugs(verified.listings)).toEqual(['near_rent_2bhk']);

    const wrongCity = await searchListingsInRadius({ ...office, filters: { citySlug: 'pune' } });
    expect(wrongCity.listings).toEqual([]);

    const puneResult = await searchListingsInRadius({
      office: PUNE_OFFICE,
      filters: { citySlug: 'pune' },
    });
    expect(slugs(puneResult.listings)).toEqual(['pune_rent']);
  });

  it('matches title and address fuzzily through the trigram indexes', async () => {
    const byTitle = await searchListingsInRadius({ ...office, filters: { query: 'villa' } });
    expect(slugs(byTitle.listings)).toEqual(['far_rent_villa']);

    const byAddress = await searchListingsInRadius({ ...office, filters: { query: 'Boring' } });
    expect(slugs(byAddress.listings)).toEqual(['near_rent_2bhk']);
  });

  it('composes several filters into one result set', async () => {
    const result = await searchListingsInRadius({
      ...office,
      filters: {
        listingType: 'RENT',
        bedroomsMin: 2,
        priceMax: 30_000,
        amenitySlugs: ['lift'],
        ring: 2,
      },
    });

    expect(slugs(result.listings)).toEqual(['mid_rent_3bhk']);
  });
});

describe('searchListingsInRadius — sorting and pagination', () => {
  it('sorts by distance ascending by default', async () => {
    const result = await searchListingsInRadius(office);
    expect(slugs(result.listings)).toEqual([
      'near_rent_2bhk',
      'near_sale',
      'mid_rent_3bhk',
      'far_rent_villa',
    ]);
  });

  it('sorts by price in both directions, using rent or sale price per row', async () => {
    const cheapFirst = await searchListingsInRadius({
      ...office,
      filters: { listingType: 'RENT' },
      sort: 'price_asc',
    });
    expect(slugs(cheapFirst.listings)).toEqual([
      'near_rent_2bhk',
      'mid_rent_3bhk',
      'far_rent_villa',
    ]);

    const dearFirst = await searchListingsInRadius({
      ...office,
      filters: { listingType: 'RENT' },
      sort: 'price_desc',
    });
    expect(slugs(dearFirst.listings)).toEqual([
      'far_rent_villa',
      'mid_rent_3bhk',
      'near_rent_2bhk',
    ]);
  });

  it('pages with a keyset cursor, without gaps or repeats', async () => {
    const firstPage = await searchListingsInRadius({ ...office, limit: 2 });

    expect(firstPage.listings).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(slugs(firstPage.listings)).toEqual(['near_rent_2bhk', 'near_sale']);

    const secondPage = await searchListingsInRadius({
      ...office,
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });

    expect(slugs(secondPage.listings)).toEqual(['mid_rent_3bhk', 'far_rent_villa']);
    expect(secondPage.nextCursor).toBeNull();

    const seen = [...slugs(firstPage.listings), ...slugs(secondPage.listings)];
    expect(new Set(seen).size).toBe(4);
  });

  it('pages a descending sort correctly too', async () => {
    const first = await searchListingsInRadius({
      ...office,
      filters: { listingType: 'RENT' },
      sort: 'price_desc',
      limit: 1,
    });
    expect(slugs(first.listings)).toEqual(['far_rent_villa']);

    const second = await searchListingsInRadius({
      ...office,
      filters: { listingType: 'RENT' },
      sort: 'price_desc',
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(slugs(second.listings)).toEqual(['mid_rent_3bhk']);
  });

  it('rejects a malformed cursor rather than silently returning page one', async () => {
    await expect(
      searchListingsInRadius({ ...office, cursor: 'not-a-real-cursor' }),
    ).rejects.toThrow(/Malformed pagination cursor/);
  });

  it('rejects coordinates outside the world', async () => {
    await expect(searchListingsInRadius({ office: { lat: 91, lng: 0 } })).rejects.toThrow();
    await expect(searchListingsInRadius({ office: { lat: 0, lng: 181 } })).rejects.toThrow();
  });

  it('rejects a radius beyond the outermost ring', async () => {
    await expect(searchListingsInRadius({ ...office, radiusMeters: 50_000 })).rejects.toThrow();
  });
});

describe('findSimilarListings', () => {
  it('returns nearest published listings of the same type within the price band', async () => {
    const similar = await findSimilarListings({
      listingId: fixtures.ids.mid_rent_3bhk as string,
      priceBand: 1,
    });

    expect(slugs(similar)).not.toContain('mid_rent_3bhk');
    expect(slugs(similar)).not.toContain('near_sale');
    expect(slugs(similar)).not.toContain('draft_studio');
    // 15k and 8k are both within ±100% of 25k; 60k is not. The 28k Pune listing
    // is in band but 1,500 km away, so the distance bound drops it.
    expect(slugs(similar).sort()).toEqual(['near_rent_2bhk', 'outside_radius']);
  });

  it('orders by proximity to the subject listing', async () => {
    const similar = await findSimilarListings({
      listingId: fixtures.ids.mid_rent_3bhk as string,
      priceBand: 1,
    });

    // 1 km away beats 2 km away.
    expect(slugs(similar)[0]).toBe('near_rent_2bhk');
    expect(similar[0]?.distanceMeters).toBeLessThan(similar[1]?.distanceMeters ?? Infinity);
  });

  it('narrows with a tighter price band', async () => {
    const similar = await findSimilarListings({
      listingId: fixtures.ids.mid_rent_3bhk as string,
      priceBand: 0.1,
    });
    expect(similar).toEqual([]);
  });

  it('returns nothing for an unknown listing id', async () => {
    const similar = await findSimilarListings({ listingId: 'does-not-exist' });
    expect(similar).toEqual([]);
  });
});

describe('straightLineDistanceMeters', () => {
  it('measures a known north offset', async () => {
    const meters = await straightLineDistanceMeters(PATNA_OFFICE, north(PATNA_OFFICE, 2_000));
    expectMeters(meters, 2_000);
  });

  it('is zero for the same point', async () => {
    const meters = await straightLineDistanceMeters(PATNA_OFFICE, PATNA_OFFICE);
    expect(meters).toBe(0);
  });
});

describe('searchPlacesLocally — the office picker', () => {
  /**
   * The way anyone types a place.
   *
   * A listing matches on its `address` column, which already contains the city,
   * so adding the city to the query used to RAISE every listing's similarity
   * and LOWER the locality's — until "Boring Road, Patna" returned eight flats
   * and no locality at all, and you could not set your office to a locality by
   * naming it. See docs/ux-audit.md 1.10.
   */
  it('puts the locality first whether or not the city is typed', async () => {
    const city = await prisma.city.findUniqueOrThrow({ where: { slug: 'patna' } });

    await prisma.locality.create({
      data: {
        cityId: city.id,
        slug: 'boring-road',
        name: 'Boring Road',
        lat: 25.6127,
        lng: 85.1145,
      },
    });

    for (const query of ['Boring Road', 'Boring Road, Patna']) {
      const rows = await searchPlacesLocally({ query, limit: 5 });
      const first = rows[0];

      expect(first, `no suggestions at all for "${query}"`).toBeDefined();
      expect(first?.kind, `"${query}" did not put the locality first`).toBe('locality');
      expect(first?.label).toBe('Boring Road');
    }
  });

  it('still finds a locality the query only partly names', async () => {
    // The bare-name path has to keep working — it is the one the trigram index
    // serves, and the qualified form is an addition rather than a replacement.
    const rows = await searchPlacesLocally({ query: 'borng road', limit: 5 });

    expect(rows.some((row) => row.kind === 'locality' && row.label === 'Boring Road')).toBe(true);
  });
});
