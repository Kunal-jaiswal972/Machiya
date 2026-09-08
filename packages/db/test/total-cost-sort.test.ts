import { computeCommuteCost, computeMonthlyOutlay, type CommuteSqlParams } from '@machiya/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/client.js';
import { listingsInRadius, searchListingsInRadius } from '../src/geo-queries.js';

/**
 * The total-cost sort, against real PostGIS.
 *
 * Two things need proving and neither can be mocked:
 *
 *  1. **The SQL agrees with the TypeScript.** The commute cost is computed
 *     twice — once by `computeCommuteCost` for display and once as a SQL
 *     expression so it can be ordered and paged on. An ORDER BY that disagreed
 *     with the number printed on the card would be the worst bug this feature
 *     could have, so the duplication is pinned rather than trusted.
 *  2. **The keyset is correct across pages.** A page-local sort would rank 24
 *     arbitrary listings, which is precisely the inversion the feature exists
 *     to expose.
 */
const OFFICE = { lat: 25.6127, lng: 85.1145 };

const COMMUTE: CommuteSqlParams = {
  mode: 'car',
  fuelPricePerLitre: 113.37,
  mileageKmPerLitre: 15,
  tripsPerDay: 2,
  workingDaysPerMonth: 22,
};

/**
 * Fixtures built so that rent order and total order DISAGREE, with the
 * arithmetic checked rather than assumed.
 *
 * The cheap-but-far flat is the whole point. At 113.37 a litre and 15 km/l over
 * 44 trips: 1,600 m of road costs 532.08 a month and 5,000 m costs 1,662.76 —
 * a commute gap of 1,130.68 against a rent gap of only 400. So the cheaper rent
 * loses by 730, and a rent-ordered list would put it first.
 *
 * The first draft of this used a 1,200 rent gap and did NOT invert, because the
 * gap exceeded the commute difference. Worth recording: the inversion needs the
 * commute spread to beat the rent spread, which is exactly why it is rarer in
 * the seed data than the feature's importance suggests.
 */
const FIXTURES = [
  { slug: 'near-pricey', rent: 17_000, maintenance: 0, meters: 1_600 },
  { slug: 'far-cheap', rent: 16_600, maintenance: 0, meters: 5_000 },
  { slug: 'near-cheapest', rent: 12_000, maintenance: 0, meters: 900 },
  { slug: 'maintenance-heavy', rent: 12_000, maintenance: 3_000, meters: 900 },
  { slug: 'for-sale', rent: null, maintenance: 0, meters: 1_200 },
];

let cityId: string;
let ids: Map<string, string>;

beforeAll(async () => {
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
    },
    select: { id: true },
  });
  cityId = city.id;

  const owner = await prisma.user.create({
    data: { email: 'owner@test.local', name: 'Owner', role: 'EDITOR', emailVerified: true },
  });

  ids = new Map();

  for (const [index, fixture] of FIXTURES.entries()) {
    // Spread along a line north of the office, all comfortably inside 3 km of
    // straight-line distance so the radius filter keeps every one — the ROAD
    // distances are supplied separately and are what the cost uses.
    const listing = await prisma.listing.create({
      data: {
        slug: fixture.slug,
        ownerId: owner.id,
        cityId,
        title: fixture.slug,
        description: 'Fixture.',
        listingType: fixture.rent === null ? 'SALE' : 'RENT',
        propertyType: 'APARTMENT',
        furnishing: 'SEMI_FURNISHED',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        address: 'Somewhere',
        locality: 'Boring Road',
        lat: OFFICE.lat + 0.002 * (index + 1),
        lng: OFFICE.lng,
        bedrooms: 2,
        bathrooms: 2,
        areaSqft: 900,
        rentAmount: fixture.rent,
        salePrice: fixture.rent === null ? 6_000_000 : null,
        maintenanceMonthly: fixture.maintenance,
      },
      select: { id: true },
    });
    ids.set(fixture.slug, listing.id);
  }
});

/** The measured distances, as the API would hand them over. */
function roadDistances() {
  return FIXTURES.map((fixture) => ({
    listingId: ids.get(fixture.slug)!,
    meters: fixture.meters,
    estimated: false,
  }));
}

describe('the SQL agrees with the cost engine', () => {
  it('computes the same commute cost the TypeScript does, per row', async () => {
    const result = await searchListingsInRadius({
      office: OFFICE,
      sort: 'distance',
      commute: COMMUTE,
      roadDistances: roadDistances(),
      limit: 50,
    });

    expect(result.listings).toHaveLength(FIXTURES.length);

    for (const listing of result.listings) {
      const fixture = FIXTURES.find((candidate) => candidate.slug === listing.slug);
      const expected = computeCommuteCost({
        ...COMMUTE,
        roadDistanceMeters: fixture!.meters,
        fuelType: 'PETROL',
      });

      // Both round to two decimals, so they must agree exactly.
      expect(listing.commuteMonthly).toBeCloseTo(expected.perMonth, 1);
      expect(listing.roadDistanceMeters).toBe(fixture!.meters);
      expect(listing.commuteEstimated).toBe(false);
    }
  });

  it('computes the same total the outlay function does', async () => {
    const result = await searchListingsInRadius({
      office: OFFICE,
      sort: 'distance',
      commute: COMMUTE,
      roadDistances: roadDistances(),
      limit: 50,
    });

    for (const listing of result.listings) {
      const fixture = FIXTURES.find((candidate) => candidate.slug === listing.slug)!;
      const commute = computeCommuteCost({
        ...COMMUTE,
        roadDistanceMeters: fixture.meters,
        fuelType: 'PETROL',
      });
      const expected = computeMonthlyOutlay({
        rent: fixture.rent,
        maintenanceMonthly: fixture.maintenance,
        commuteMonthly: commute.perMonth,
      });

      if (expected.total === null) {
        expect(listing.totalMonthlyCost).toBeNull();
      } else {
        expect(listing.totalMonthlyCost).toBeCloseTo(expected.total, 1);
      }
    }
  });
});

describe('the sort', () => {
  it('surfaces the inversion: cheaper rent further out LOSES', async () => {
    const result = await searchListingsInRadius({
      office: OFFICE,
      sort: 'total_cost',
      commute: COMMUTE,
      roadDistances: roadDistances(),
      limit: 50,
    });

    const order = result.listings.map((listing) => listing.slug);

    // `far-cheap` has 400 less rent than `near-pricey` and 3.4 km more road,
    // which costs 1,130 more than it saves. Ranking by rent puts it first;
    // ranking by what it actually costs to live there does not.
    expect(order.indexOf('near-pricey')).toBeLessThan(order.indexOf('far-cheap'));

    const byRent = [...result.listings]
      .filter((listing) => listing.rentAmount !== null)
      .sort((a, b) => (a.rentAmount ?? 0) - (b.rentAmount ?? 0))
      .map((listing) => listing.slug);

    expect(order.filter((slug) => slug !== 'for-sale')).not.toEqual(byRent);
  });

  it('counts maintenance, not only rent and commute', async () => {
    const result = await searchListingsInRadius({
      office: OFFICE,
      sort: 'total_cost',
      commute: COMMUTE,
      roadDistances: roadDistances(),
      limit: 50,
    });

    const order = result.listings.map((listing) => listing.slug);

    // Same rent, same distance, 3,000 of maintenance between them.
    expect(order.indexOf('near-cheapest')).toBeLessThan(order.indexOf('maintenance-heavy'));
  });

  it('puts a sale listing last rather than giving it a fabricated total', async () => {
    const result = await searchListingsInRadius({
      office: OFFICE,
      sort: 'total_cost',
      commute: COMMUTE,
      roadDistances: roadDistances(),
      limit: 50,
    });

    expect(result.listings.at(-1)?.slug).toBe('for-sale');
    expect(result.listings.at(-1)?.totalMonthlyCost).toBeNull();
  });

  it('is monotonic, and identical across keyset pages', async () => {
    const seen: string[] = [];
    const totals: (number | null)[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page += 1) {
      const result = await searchListingsInRadius({
        office: OFFICE,
        sort: 'total_cost',
        commute: COMMUTE,
        roadDistances: roadDistances(),
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });

      seen.push(...result.listings.map((listing) => listing.slug));
      totals.push(...result.listings.map((listing) => listing.totalMonthlyCost));

      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    // No duplicates and nothing lost, which is what a broken keyset produces.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(FIXTURES.length);

    const ranked = totals.filter((total): total is number => total !== null);
    for (let index = 1; index < ranked.length; index += 1) {
      expect(ranked[index]!).toBeGreaterThanOrEqual(ranked[index - 1]!);
    }

    const unpaged = await searchListingsInRadius({
      office: OFFICE,
      sort: 'total_cost',
      commute: COMMUTE,
      roadDistances: roadDistances(),
      limit: 50,
    });

    expect(seen).toEqual(unpaged.listings.map((listing) => listing.slug));
  });

  it('refuses rather than silently sorting by something else', async () => {
    // Without the inputs there is no total cost to rank by, and quietly
    // ordering by distance while the UI says "total cost" would be a lie about
    // the product's headline feature. The API downgrades explicitly instead.
    await expect(
      searchListingsInRadius({ office: OFFICE, sort: 'total_cost', limit: 10 }),
    ).rejects.toThrow(/requires commute parameters/);
  });
});

describe('commute columns are absent unless asked for', () => {
  it('returns nulls and no OSRM dependency for an ordinary sort', async () => {
    const result = await searchListingsInRadius({ office: OFFICE, sort: 'distance', limit: 50 });

    for (const listing of result.listings) {
      expect(listing.roadDistanceMeters).toBeNull();
      expect(listing.commuteMonthly).toBeNull();
      expect(listing.totalMonthlyCost).toBeNull();
      expect(listing.commuteEstimated).toBe(false);
    }
  });

  it('marks a listing whose distance was estimated', async () => {
    const distances = roadDistances().map((distance, index) =>
      index === 0 ? { ...distance, estimated: true } : distance,
    );

    const result = await searchListingsInRadius({
      office: OFFICE,
      sort: 'distance',
      commute: COMMUTE,
      roadDistances: distances,
      limit: 50,
    });

    const estimated = result.listings.filter((listing) => listing.commuteEstimated);
    expect(estimated).toHaveLength(1);
  });

  it('treats a listing MISSING from the matrix as estimated, never as free', async () => {
    // A routing failure must not delete a listing or hand it a zero commute.
    const partial = roadDistances().slice(1);

    const result = await searchListingsInRadius({
      office: OFFICE,
      sort: 'distance',
      commute: COMMUTE,
      roadDistances: partial,
      limit: 50,
    });

    // Every listing still present.
    expect(result.listings).toHaveLength(FIXTURES.length);

    const orphan = result.listings.find((listing) => listing.slug === FIXTURES[0]!.slug);
    expect(orphan?.commuteEstimated).toBe(true);
    expect(orphan?.roadDistanceMeters).toBeNull();
  });
});

describe('listingsInRadius', () => {
  it('returns the whole filtered candidate set, id-ordered', async () => {
    const candidates = await listingsInRadius({
      office: OFFICE,
      radiusMeters: 3000,
      filters: {},
      statuses: ['PUBLISHED'],
    });

    expect(candidates).toHaveLength(FIXTURES.length);
    // Ordered so the caller's candidate-set hash is stable across requests.
    expect([...candidates].map((c) => c.id).sort()).toEqual(candidates.map((c) => c.id));
  });

  it('honours the filters, so the matrix is not measured for excluded rows', async () => {
    const candidates = await listingsInRadius({
      office: OFFICE,
      radiusMeters: 3000,
      filters: { listingType: 'SALE' },
      statuses: ['PUBLISHED'],
    });

    expect(candidates).toHaveLength(1);
  });
});
