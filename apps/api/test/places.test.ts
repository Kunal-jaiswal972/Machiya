import { prisma } from '@machiya/db';
import type { GeocodeProvider, GeocodeResult } from '@machiya/shared';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tier 1 runs against real Postgres with real pg_trgm — the point of these
 * tests is that the trigram operators and the prefix path behave as the ranking
 * assumes, which a mocked query would prove nothing about.
 *
 * Tier 2 is stubbed. It is an HTTP call to another process; what needs testing
 * here is the gating (when is it reached at all) and the merge, not Nominatim.
 */
const remoteResults: GeocodeResult[] = [];
let remoteCalls = 0;

vi.mock('../src/geo/nominatim.js', () => ({
  resolveGeocodeProvider: (): GeocodeProvider => ({
    name: 'nominatim',
    search: async () => {
      remoteCalls += 1;
      return remoteResults;
    },
    reverse: async () => null,
  }),
}));

const { suggestPlaces } = await import('../src/services/places.js');

function remote(overrides: Partial<GeocodeResult> = {}): GeocodeResult {
  return {
    id: `nominatim:${String(Math.random())}`,
    label: 'Somewhere Else',
    lat: 25.6,
    lng: 85.14,
    kind: 'address',
    source: 'nominatim',
    score: 0.5,
    ...overrides,
  };
}

async function seedPlaces(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "ListingAmenity", "ListingImage", "ListingView", "Favorite",
      "EnquiryMessage", "Enquiry", "SavedSearch", "FuelPrice", "Listing",
      "OfficeLocation", "Amenity", "Locality", "Session", "Account", "User", "City"
      RESTART IDENTITY CASCADE
  `);

  const city = await prisma.city.create({
    data: {
      slug: 'bengaluru',
      name: 'Bengaluru',
      state: 'Karnataka',
      centroidLat: 12.9716,
      centroidLng: 77.5946,
      bbox: { minLng: 77.45, minLat: 12.82, maxLng: 77.78, maxLat: 13.14 },
    },
  });

  await prisma.locality.createMany({
    data: [
      { cityId: city.id, slug: 'koramangala', name: 'Koramangala', lat: 12.9352, lng: 77.6245 },
      { cityId: city.id, slug: 'indiranagar', name: 'Indiranagar', lat: 12.9784, lng: 77.6408 },
    ],
  });

  const owner = await prisma.user.create({
    data: { email: 'owner@test.local', name: 'Owner', role: 'LISTER', emailVerified: true },
  });

  await prisma.listing.create({
    data: {
      slug: 'bengaluru-quiet-2bhk-abc123',
      ownerId: owner.id,
      cityId: city.id,
      title: 'Quiet 2BHK in Koramangala',
      description: 'A quiet two bedroom flat.',
      listingType: 'RENT',
      propertyType: 'APARTMENT',
      furnishing: 'SEMI_FURNISHED',
      status: 'PUBLISHED',
      publishedAt: new Date(),
      address: '5th Block, Koramangala',
      locality: 'Koramangala',
      lat: 12.9355,
      lng: 77.625,
      bedrooms: 2,
      bathrooms: 2,
      areaSqft: 1100,
      rentAmount: 32_000,
    },
  });

  // A draft must never be suggested: the local tier is a public surface.
  await prisma.listing.create({
    data: {
      slug: 'bengaluru-secret-draft-def456',
      ownerId: owner.id,
      cityId: city.id,
      title: 'Secret draft in Koramangala',
      description: 'Not published.',
      listingType: 'RENT',
      propertyType: 'APARTMENT',
      furnishing: 'UNFURNISHED',
      status: 'DRAFT',
      address: '6th Block, Koramangala',
      locality: 'Koramangala',
      lat: 12.936,
      lng: 77.626,
      bedrooms: 1,
      bathrooms: 1,
      areaSqft: 500,
      rentAmount: 18_000,
    },
  });
}

beforeEach(async () => {
  remoteResults.length = 0;
  remoteCalls = 0;
  await seedPlaces();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('tier 1 — local trigram search', () => {
  it('matches a locality by prefix, which is how typing actually starts', async () => {
    const result = await suggestPlaces({ q: 'ko', limit: 8 });

    expect(result.suggestions[0]).toMatchObject({
      label: 'Koramangala',
      kind: 'locality',
      source: 'local',
    });
    // Two characters must never reach a shared free geocoder.
    expect(remoteCalls).toBe(0);
  });

  it('matches a misspelling by trigram similarity', async () => {
    const result = await suggestPlaces({ q: 'koramangla', limit: 8 });

    expect(result.suggestions.map((s) => s.label)).toContain('Koramangala');
  });

  it('ranks a city above a listing that merely contains the word', async () => {
    const result = await suggestPlaces({ q: 'bengaluru', limit: 8 });

    expect(result.suggestions[0]).toMatchObject({ label: 'Bengaluru', kind: 'city' });
  });

  it('carries a city bbox, so selecting a city can fit the map to it', async () => {
    const result = await suggestPlaces({ q: 'bengaluru', limit: 8 });

    expect(result.suggestions[0]?.bbox).toEqual({
      minLng: 77.45,
      minLat: 12.82,
      maxLng: 77.78,
      maxLat: 13.14,
    });
  });

  it('suggests a published listing with its slug', async () => {
    const result = await suggestPlaces({ q: 'quiet 2bhk', limit: 8 });
    const listing = result.suggestions.find((s) => s.kind === 'listing');

    expect(listing?.listingSlug).toBe('bengaluru-quiet-2bhk-abc123');
  });

  it('never suggests a draft listing', async () => {
    const result = await suggestPlaces({ q: 'secret', limit: 8 });

    expect(result.suggestions).toHaveLength(0);
  });

  it('restricts to one city when asked', async () => {
    const result = await suggestPlaces({ q: 'ko', citySlug: 'patna', limit: 8 });

    expect(result.suggestions).toHaveLength(0);
  });
});

describe('tier 2 — gating', () => {
  it('is skipped below the minimum character count', async () => {
    await suggestPlaces({ q: 'ko', limit: 8 });

    expect(remoteCalls).toBe(0);
  });

  it('is skipped when tier 1 already returned enough', async () => {
    // Five localities sharing a prefix takes the local answer to the
    // sufficiency bar, which is what suppresses the upstream call.
    const city = await prisma.city.findUniqueOrThrow({ where: { slug: 'bengaluru' } });
    await prisma.locality.createMany({
      data: ['Kodihalli', 'Kodigehalli', 'Kodathi', 'Kodichikkanahalli', 'Kodigepalya'].map(
        (name) => ({
          cityId: city.id,
          slug: name.toLowerCase().replace(/\s+/g, '-'),
          name,
          lat: 13,
          lng: 77.6,
        }),
      ),
    });

    const result = await suggestPlaces({ q: 'kod', limit: 8 });

    expect(result.suggestions.length).toBeGreaterThanOrEqual(5);
    expect(remoteCalls).toBe(0);
    expect(result.degraded).toBe(false);
  });

  it('runs when tier 1 came up short, and merges the two', async () => {
    remoteResults.push(remote({ label: 'Whitefield Main Road', lat: 12.97, lng: 77.75 }));

    const result = await suggestPlaces({ q: 'whitefield', limit: 8 });

    expect(remoteCalls).toBe(1);
    expect(result.sources).toContain('nominatim');
    expect(result.suggestions.map((s) => s.label)).toContain('Whitefield Main Road');
  });

  it('reports degraded when tier 2 was needed and answered nothing', async () => {
    const result = await suggestPlaces({ q: 'whitefield', limit: 8 });

    expect(remoteCalls).toBe(1);
    expect(result.degraded).toBe(true);
  });

  it('still serves the local rows when tier 2 is down', async () => {
    const result = await suggestPlaces({ q: 'indira', limit: 8 });

    expect(result.degraded).toBe(true);
    expect(result.suggestions.map((s) => s.label)).toContain('Indiranagar');
  });
});

describe('merging', () => {
  it('keeps the local row when both tiers return the same place', async () => {
    remoteResults.push(
      // Same place, higher score, no citySlug — the local row must still win,
      // because it is the one carrying data the UI can act on.
      remote({ label: 'koramangala', lat: 12.9352, lng: 77.6245, score: 0.99 }),
    );

    const result = await suggestPlaces({ q: 'koramangala junction', limit: 8 });
    const matches = result.suggestions.filter((s) => s.label.toLowerCase() === 'koramangala');

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ source: 'local', citySlug: 'bengaluru' });
  });

  it('keeps two different places that share a name', async () => {
    remoteResults.push(
      remote({ label: 'Koramangala', lat: 25.6, lng: 85.14, score: 0.7 }),
      remote({ label: 'Koramangala', lat: 18.52, lng: 73.85, score: 0.6 }),
    );

    const result = await suggestPlaces({ q: 'koramangala road', limit: 8 });
    const matches = result.suggestions.filter((s) => s.label === 'Koramangala');

    // Two remote ones plus our own local one, all at different coordinates.
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('never returns more than the requested limit', async () => {
    remoteResults.push(
      ...Array.from({ length: 10 }, (_, n) => remote({ label: `Remote ${String(n)}` })),
    );

    const result = await suggestPlaces({ q: 'remote', limit: 3 });

    expect(result.suggestions).toHaveLength(3);
  });

  it('orders strictly by score, so the list does not shuffle between keystrokes', async () => {
    remoteResults.push(
      remote({ label: 'Middle', score: 0.5 }),
      remote({ label: 'Highest', score: 0.8 }),
      remote({ label: 'Lowest', score: 0.2 }),
    );

    const result = await suggestPlaces({ q: 'nothing local matches this', limit: 8 });

    expect(result.suggestions.map((s) => s.label)).toEqual(['Highest', 'Middle', 'Lowest']);
  });
});
