import { prisma } from '@machiya/db';
import type { GeocodeProvider, GeocodeSearchOutcome } from '@machiya/shared';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Address precision, and the one place a strip happens.
 *
 * Tier 1 runs against real Postgres with real `pg_trgm`, because the claim
 * under test is that **trigram similarity already degrades a street address to
 * its locality** — the reason there is no stripping in the service. A mocked
 * query would assert nothing about that.
 *
 * Tier 2 is stubbed, and the stub records the exact queries it was asked, which
 * is how "one retry, never a loop" and "no retry when the first query
 * succeeded" become checkable rather than asserted in a comment.
 */
const asked: string[] = [];
/** Queries the stubbed upstream will answer. Everything else returns empty. */
const answers = new Map<string, GeocodeSearchOutcome['results']>();

vi.mock('../src/geo/nominatim.js', () => ({
  resolveGeocodeProvider: (): GeocodeProvider => ({
    name: 'nominatim',
    search: async (query: string) => {
      asked.push(query);
      return { results: answers.get(query) ?? [], refused: false };
    },
    reverse: async () => null,
  }),
}));

const { suggestPlaces } = await import('../src/services/places.js');

async function seedPatna(): Promise<void> {
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
  });

  await prisma.locality.createMany({
    data: [
      {
        cityId: city.id,
        slug: 'rajendra-nagar',
        name: 'Rajendra Nagar',
        lat: 25.6053,
        lng: 85.1567,
      },
      { cityId: city.id, slug: 'boring-road', name: 'Boring Road', lat: 25.6127, lng: 85.1145 },
      {
        cityId: city.id,
        slug: 'patliputra-colony',
        name: 'Patliputra Colony',
        lat: 25.6229,
        lng: 85.1093,
      },
    ],
  });

  const owner = await prisma.user.create({
    data: { email: 'owner@test.local', name: 'Owner', role: 'EDITOR', emailVerified: true },
  });

  // A listing whose TITLE carries the locality name. This is what used to
  // outrank the locality for a long address query, which would have set the
  // office to one specific flat.
  await prisma.listing.create({
    data: {
      slug: 'patna-1-bhk-rajendra-nagar-aaa111',
      ownerId: owner.id,
      cityId: city.id,
      title: '1 BHK apartment in Rajendra Nagar',
      description: 'A one bedroom flat.',
      listingType: 'RENT',
      propertyType: 'APARTMENT',
      furnishing: 'SEMI_FURNISHED',
      status: 'PUBLISHED',
      publishedAt: new Date(),
      address: 'Road 3, Rajendra Nagar',
      locality: 'Rajendra Nagar',
      lat: 25.6055,
      lng: 85.157,
      bedrooms: 1,
      bathrooms: 1,
      areaSqft: 600,
      rentAmount: 12_000,
    },
  });
}

beforeEach(async () => {
  asked.length = 0;
  answers.clear();
  await seedPatna();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('tier 1 already degrades an address to its locality', () => {
  it('answers a full address with a house number, without any stripping', async () => {
    const result = await suggestPlaces({ q: 'House 47, Road 3, Rajendra Nagar, Patna', limit: 8 });

    expect(result.suggestions[0]).toMatchObject({
      label: 'Rajendra Nagar',
      kind: 'locality',
      source: 'local',
      matchPrecision: 'locality',
    });
  });

  it('ranks the LOCALITY above a listing whose title contains it', async () => {
    // The measured failure this weighting fixes: for a long address query the
    // listing rows scored level with the locality, so an address search set the
    // office to a specific flat rather than to the neighbourhood.
    const result = await suggestPlaces({ q: 'Flat 4B, 21 Patliputra Colony, Patna', limit: 8 });

    expect(result.suggestions[0]).toMatchObject({
      label: 'Patliputra Colony',
      kind: 'locality',
    });
  });

  it('does NOT demote listings for a plain place-name query', async () => {
    // The weighting is keyed on the query reading as a street address. Someone
    // searching "Rajendra Nagar" may well want the listing, so the ordinary
    // 0.8 weight applies and the listing stays in the list.
    const result = await suggestPlaces({ q: 'Rajendra Nagar', limit: 8 });

    expect(result.suggestions[0]).toMatchObject({ label: 'Rajendra Nagar', kind: 'locality' });
    expect(result.suggestions.some((s) => s.kind === 'listing')).toBe(true);
  });

  it('tags a locality `locality` and a city `area`, by construction', async () => {
    const locality = await suggestPlaces({ q: 'Boring Road', limit: 8 });
    expect(locality.suggestions[0]?.matchPrecision).toBe('locality');

    const city = await suggestPlaces({ q: 'Patna', limit: 8 });
    expect(city.suggestions.find((s) => s.kind === 'city')?.matchPrecision).toBe('area');
  });

  it('returns empty for nonsense rather than a wrongly-truncated match', async () => {
    const result = await suggestPlaces({ q: 'Qzxwv Road, Patna', limit: 8 });

    expect(result.suggestions.every((s) => s.label !== 'Rajendra Nagar')).toBe(true);
    // Whatever it returns, it must not have invented a street-level answer.
    expect(result.suggestions.every((s) => s.matchPrecision !== 'exact')).toBe(true);
  });
});

describe('the service hands tier 2 the query unchanged', () => {
  it('asks once, with the words the user typed', async () => {
    answers.set('Anisabad, Patna', [
      {
        id: 'nominatim:1',
        label: 'Anisabad',
        lat: 25.58,
        lng: 85.12,
        kind: 'locality',
        source: 'nominatim',
        matchPrecision: 'locality',
        score: 0.6,
      },
    ]);

    const result = await suggestPlaces({ q: 'Anisabad, Patna', limit: 8 });

    // ONE call, and the raw query. Normalisation, caching and the stripped
    // retry all live inside the adapter, so the service cannot half-apply any
    // of them — and a second local query here would be doing work trigram has
    // already done. `nominatim.test.ts` covers what the adapter then does.
    expect(asked).toEqual(['Anisabad, Patna']);
    expect(result.suggestions.some((s) => s.label === 'Anisabad')).toBe(true);
  });

  it('reaches tier 2 for a locality tier 1 does not hold', async () => {
    // Anisabad is a real Patna neighbourhood and not one of our `Locality`
    // rows, which is the gap tier 2 exists to cover — and the only place a
    // strip earns its keep.
    await suggestPlaces({ q: 'House 12, Anisabad, Patna', limit: 8 });

    expect(asked).toEqual(['House 12, Anisabad, Patna']);
  });
});
