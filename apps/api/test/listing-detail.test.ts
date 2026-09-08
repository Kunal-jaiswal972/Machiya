import { prisma } from '@machiya/db';
import type { PoiProvider, RouteResult, RoutingProvider } from '@machiya/shared';
import type * as OsrmModule from '../src/geo/osrm.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The detail view's satellite reads.
 *
 * The two providers are stubbed — they are HTTP calls to other processes, and
 * what needs testing here is what happens when they answer, when they refuse,
 * and when they are simply not there. Real Postgres underneath, because the view
 * counter is a transaction and the dedupe is a real query.
 */
let routeAnswer: RouteResult | null = null;
let routeCalls = 0;
let poiAnswer: Awaited<ReturnType<PoiProvider['nearby']>> = {
  pois: [],
  degraded: false,
  fetchedAt: new Date().toISOString(),
};

// `estimateRoute` is the real one: the fallback maths is part of what is under
// test here, and only the provider lookup is replaced.
vi.mock('../src/geo/osrm.js', async (importOriginal) => {
  const original = await importOriginal<typeof OsrmModule>();
  return {
    ...original,
    resolveRoutingProvider: (): RoutingProvider => ({
      name: 'stub',
      route: async () => {
        routeCalls += 1;
        return routeAnswer;
      },
      // Unused here — the detail panel routes one listing at a time — but part
      // of the interface, and the typecheck now says so. It answers null, which
      // is the "no matrix" case every caller already handles by estimating.
      table: async () => null,
    }),
  };
});

vi.mock('../src/geo/overpass.js', () => ({
  resolvePoiProvider: (): PoiProvider => ({
    name: 'stub',
    nearby: async () => poiAnswer,
  }),
}));

const { getListingPois, getListingRoute, getSimilarListings, recordListingView } =
  await import('../src/services/listing-detail.js');

const OFFICE = { lat: 25.6127, lng: 85.1145 };
let listingId = '';
let ownerId = '';

async function seedOneListing(options: { status?: 'PUBLISHED' | 'DRAFT' } = {}) {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "ListingImage", "ListingView", "Listing", "User", "City"
      RESTART IDENTITY CASCADE
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
  });

  const owner = await prisma.user.create({
    data: { email: 'owner@test.local', name: 'Owner', role: 'EDITOR', emailVerified: true },
  });
  ownerId = owner.id;

  const listing = await prisma.listing.create({
    data: {
      slug: 'patna-subject-abc123',
      ownerId: owner.id,
      cityId: city.id,
      title: 'Subject listing',
      description: 'The listing under test.',
      listingType: 'RENT',
      propertyType: 'APARTMENT',
      furnishing: 'SEMI_FURNISHED',
      status: options.status ?? 'PUBLISHED',
      publishedAt: new Date(),
      address: 'Boring Road, Patna',
      locality: 'Boring Road',
      lat: 25.6135,
      lng: 85.1145,
      bedrooms: 2,
      bathrooms: 2,
      areaSqft: 1000,
      rentAmount: 18_000,
    },
  });

  listingId = listing.id;
  return listing;
}

beforeEach(async () => {
  routeCalls = 0;
  routeAnswer = null;
  poiAnswer = { pois: [], degraded: false, fetchedAt: new Date().toISOString() };
  await seedOneListing();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('getListingRoute', () => {
  it('returns the provider’s road route when there is one', async () => {
    routeAnswer = {
      profile: 'car',
      distanceMeters: 4_200,
      durationSeconds: 780,
      geometry: {
        type: 'LineString',
        coordinates: [
          [85.11, 25.61],
          [85.12, 25.62],
        ],
      },
      degraded: false,
    };

    const route = await getListingRoute({
      slug: 'patna-subject-abc123',
      from: OFFICE,
      profile: 'car',
    });

    expect(route).toMatchObject({ distanceMeters: 4_200, degraded: false });
    expect(route.geometry?.coordinates).toHaveLength(2);
  });

  it('falls back to a straight-line estimate MARKED degraded when OSRM has nothing', async () => {
    routeAnswer = null;

    const route = await getListingRoute({
      slug: 'patna-subject-abc123',
      from: OFFICE,
      profile: 'car',
    });

    // The flag is the point: an estimate presented as a measurement would
    // undermine the one thing this product is selling.
    expect(route.degraded).toBe(true);
    expect(route.geometry).toBeNull();
    // ~89m straight line, inflated by the detour factor.
    expect(route.distanceMeters).toBeGreaterThan(0);
    expect(routeCalls).toBe(1);
  });

  it('estimates a bike route as slower per kilometre than a car', async () => {
    routeAnswer = null;

    const car = await getListingRoute({
      slug: 'patna-subject-abc123',
      from: OFFICE,
      profile: 'car',
    });
    const bike = await getListingRoute({
      slug: 'patna-subject-abc123',
      from: OFFICE,
      profile: 'bike',
    });

    expect(bike.distanceMeters).toBeCloseTo(car.distanceMeters, 5);
    expect(bike.durationSeconds).toBeGreaterThan(car.durationSeconds);
  });

  it('404s for a draft listing', async () => {
    await seedOneListing({ status: 'DRAFT' });

    // A draft's coordinates are the owner's business, so there is no public
    // commute panel for one.
    await expect(
      getListingRoute({ slug: 'patna-subject-abc123', from: OFFICE, profile: 'car' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('getListingPois', () => {
  it('passes the provider’s answer through', async () => {
    poiAnswer = {
      pois: [
        {
          id: 'node/1',
          category: 'pharmacy',
          name: 'MedPlus',
          lat: 25.614,
          lng: 85.115,
          distanceMeters: 180,
        },
      ],
      degraded: false,
      fetchedAt: new Date().toISOString(),
    };

    const result = await getListingPois({ slug: 'patna-subject-abc123' });

    expect(result.pois).toHaveLength(1);
    expect(result.degraded).toBe(false);
  });

  it('reports degraded rather than throwing when the upstream refused', async () => {
    poiAnswer = { pois: [], degraded: true, fetchedAt: new Date().toISOString() };

    const result = await getListingPois({ slug: 'patna-subject-abc123' });

    // Empty AND degraded together are what let the UI say "could not check"
    // rather than "none nearby" — opposite statements to someone choosing a home.
    expect(result).toMatchObject({ pois: [], degraded: true });
  });
});

describe('getSimilarListings', () => {
  it('is empty when nothing else is nearby', async () => {
    const similar = await getSimilarListings('patna-subject-abc123');

    expect(similar).toEqual([]);
  });

  it('404s for an unknown slug', async () => {
    await expect(getSimilarListings('no-such-listing')).rejects.toMatchObject({ status: 404 });
  });
});

describe('recordListingView', () => {
  it('writes a row and increments the counter together', async () => {
    const result = await recordListingView({
      slug: 'patna-subject-abc123',
      ip: '203.0.113.5',
      userAgent: 'test',
    });

    expect(result.counted).toBe(true);

    const rows = await prisma.listingView.count({ where: { listingId } });
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });

    // The rows are what the chart aggregates and the counter is what search
    // reads; they are written in one transaction so they cannot disagree.
    expect(rows).toBe(1);
    expect(listing.viewCount).toBe(1);
  });

  it('counts one view per viewer per window, not one per refresh', async () => {
    const first = await recordListingView({
      slug: 'patna-subject-abc123',
      ip: '203.0.113.9',
      userAgent: 'same-browser',
    });
    const second = await recordListingView({
      slug: 'patna-subject-abc123',
      ip: '203.0.113.9',
      userAgent: 'same-browser',
    });

    expect(first.counted).toBe(true);
    expect(second.counted).toBe(false);
    expect(await prisma.listingView.count({ where: { listingId } })).toBe(1);
  });

  it('treats a different viewer as a different view', async () => {
    await recordListingView({ slug: 'patna-subject-abc123', ip: '198.51.100.1', userAgent: 'a' });
    await recordListingView({ slug: 'patna-subject-abc123', ip: '198.51.100.2', userAgent: 'b' });

    expect(await prisma.listingView.count({ where: { listingId } })).toBe(2);
  });

  it('does not count the owner reading their own listing', async () => {
    // The single biggest source of nonsense in a small site's numbers.
    const result = await recordListingView({ slug: 'patna-subject-abc123', userId: ownerId });

    expect(result.counted).toBe(false);
    expect(await prisma.listingView.count({ where: { listingId } })).toBe(0);
  });

  it('does not count a view of a draft, and does not throw either', async () => {
    await seedOneListing({ status: 'DRAFT' });

    // A view is telemetry; the page has already decided what to render, so this
    // is silent rather than a 404.
    const result = await recordListingView({
      slug: 'patna-subject-abc123',
      ip: '203.0.113.7',
      userAgent: 'test',
    });

    expect(result.counted).toBe(false);
  });

  it('is silent for an unknown slug', async () => {
    const result = await recordListingView({ slug: 'no-such-listing', ip: '203.0.113.8' });

    expect(result.counted).toBe(false);
  });
});
