import { prisma } from '@machiya/db';
import {
  buildSearchParams,
  parseSearchQuery,
  searchQueryToInput,
  type SearchQuery,
} from '@machiya/shared';
import { variantBaseKey } from '@machiya/shared/images';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { searchListings } from '../src/services/search.js';
import { createOffice, deleteOffice, listOffices, patchOffice } from '../src/services/offices.js';
import { resetWorld, type ListingTestWorld } from './listing-fixtures.js';

let world: ListingTestWorld;

/** Boring Road, Patna — the same point the seeded seeker office uses. */
const OFFICE = { lat: 25.6127, lng: 85.1145 };

/** Metres to a crude degree offset. Good enough to place a fixture in a ring. */
function offsetBy(meters: number) {
  return { lat: OFFICE.lat + meters / 111_320, lng: OFFICE.lng };
}

async function publish(options: {
  slug: string;
  metersAway: number;
  rentAmount?: number | null;
  salePrice?: number | null;
  listingType?: 'RENT' | 'SALE';
  bedrooms?: number;
  status?: 'PUBLISHED' | 'DRAFT';
  withReadyPhoto?: boolean;
}): Promise<string> {
  const point = offsetBy(options.metersAway);

  const listing = await prisma.listing.create({
    data: {
      slug: options.slug,
      ownerId: world.ownerSession.userId,
      cityId: world.cityId,
      title: `Flat ${options.slug}`,
      description: 'A flat for the search tests.',
      listingType: options.listingType ?? 'RENT',
      propertyType: 'APARTMENT',
      furnishing: 'SEMI_FURNISHED',
      status: options.status ?? 'PUBLISHED',
      publishedAt: new Date(),
      address: 'Boring Road, Patna',
      locality: 'Boring Road',
      lat: point.lat,
      lng: point.lng,
      bedrooms: options.bedrooms ?? 2,
      bathrooms: 1,
      areaSqft: 900,
      rentAmount: options.rentAmount === undefined ? 15_000 : options.rentAmount,
      salePrice: options.salePrice ?? null,
    },
  });

  if (options.withReadyPhoto) {
    const imageId = `img-${options.slug}`;
    await prisma.listingImage.create({
      data: {
        id: imageId,
        listingId: listing.id,
        objectKey: null,
        variantBaseKey: variantBaseKey(listing.id, imageId),
        status: 'READY',
        width: 1200,
        height: 800,
        isCover: true,
        dominantColor: '#aabbcc',
        lqip: 'data:image/webp;base64,AAAA',
      },
    });
  }

  return listing.id;
}

beforeEach(async () => {
  world = await resetWorld();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Narrows the search response to its `ok` arm.
 *
 * The response is a discriminated union since correction 9, so reading
 * `listings` without checking `status` is a type error — and the check is worth
 * making loudly rather than with a cast: a test that silently read an
 * out-of-coverage response as an empty result set would be asserting the exact
 * confusion the union exists to prevent.
 */
function ok(result: Awaited<ReturnType<typeof searchListings>>) {
  if (result.status !== 'ok') {
    throw new Error(`expected an ok search, got ${result.status}`);
  }
  return result;
}

describe('searchListings', () => {
  it('bounds results by the radius and reports the ring per listing', async () => {
    await publish({ slug: 'near', metersAway: 400 });
    await publish({ slug: 'mid', metersAway: 1_500 });
    await publish({ slug: 'far', metersAway: 2_500 });
    await publish({ slug: 'outside', metersAway: 4_000 });

    const result = ok(await searchListings({ office: OFFICE, radiusMeters: 3000 }));

    expect(result.total).toBe(3);
    expect(result.ringCounts).toEqual({ 1: 1, 2: 1, 3: 1 });
    expect(result.listings.map((l) => l.slug)).not.toContain('outside');
  });

  it('reports ring counts for the whole filtered set, not just the page', async () => {
    for (let n = 0; n < 7; n += 1) {
      await publish({ slug: `ring1-${String(n)}`, metersAway: 200 + n });
    }

    const result = ok(await searchListings({ office: OFFICE, radiusMeters: 3000, limit: 3 }));

    expect(result.listings).toHaveLength(3);
    // The point of the counts is showing what picking each ring would give, so
    // they must describe the set rather than the page.
    expect(result.ringCounts[1]).toBe(7);
    expect(result.total).toBe(7);
  });

  it('never returns anything but PUBLISHED, even if asked', async () => {
    await publish({ slug: 'live', metersAway: 300 });
    await publish({ slug: 'draft', metersAway: 300, status: 'DRAFT' });

    // A client cannot widen the status set: search is a public surface.
    const result = ok(
      await searchListings({
        office: OFFICE,
        radiusMeters: 3000,
        statuses: ['PUBLISHED', 'DRAFT'],
      }),
    );

    expect(result.listings.map((l) => l.slug)).toEqual(['live']);
  });

  it('resolves the cover photo to a variant URL, not the original key', async () => {
    await publish({ slug: 'with-photo', metersAway: 300, withReadyPhoto: true });

    const result = ok(await searchListings({ office: OFFICE, radiusMeters: 3000 }));
    const card = result.listings[0];

    // The original is deleted after derivation, so a URL built from objectKey
    // would be null for every processed listing.
    expect(card?.coverUrl).toMatch(/\/variants\/.+\/card\.webp$/);
    expect(card?.coverLqip).toBe('data:image/webp;base64,AAAA');
    expect(card?.coverDominantColor).toBe('#aabbcc');
  });

  it('has no cover while the photo is still PENDING', async () => {
    const listingId = await publish({ slug: 'pending-photo', metersAway: 300 });
    await prisma.listingImage.create({
      data: {
        listingId,
        objectKey: 'originals/x/y.jpg',
        variantBaseKey: variantBaseKey(listingId, 'y'),
        status: 'PENDING',
        width: 0,
        height: 0,
        isCover: true,
      },
    });

    const result = ok(await searchListings({ office: OFFICE, radiusMeters: 3000 }));

    // A PENDING row has no servable bytes; a URL for it would 404.
    expect(result.listings[0]?.coverUrl).toBeNull();
  });

  it('sorts by price ascending', async () => {
    await publish({ slug: 'cheap', metersAway: 300, rentAmount: 9_000 });
    await publish({ slug: 'dear', metersAway: 300, rentAmount: 30_000 });

    const result = ok(
      await searchListings({ office: OFFICE, radiusMeters: 3000, sort: 'price_asc' }),
    );

    expect(result.listings.map((l) => l.slug)).toEqual(['cheap', 'dear']);
  });

  // This case used to publish a rental with a null rent and assert it sorted
  // last. It cannot exist any more, and the COALESCE that handled it is now
  // defence in depth rather than a live path — so the assertion moves to the
  // thing that made it unreachable.
  it('cannot store a published rental with no rent at all', async () => {
    await expect(publish({ slug: 'unpriced', metersAway: 300, rentAmount: null })).rejects.toThrow(
      /listing_complete_when_live/,
    );

    const result = ok(await searchListings({ office: OFFICE, radiusMeters: 3000 }));
    expect(result.listings).toHaveLength(0);
  });

  it('compares a rental against rent and a sale against sale price', async () => {
    await publish({ slug: 'rental', metersAway: 300, rentAmount: 20_000 });
    await publish({
      slug: 'sale',
      metersAway: 300,
      listingType: 'SALE',
      rentAmount: null,
      salePrice: 7_500_000,
    });

    // A price range in rupees would otherwise compare a monthly rent against a
    // purchase price, which is meaningless.
    const rentals = ok(
      await searchListings({
        office: OFFICE,
        radiusMeters: 3000,
        filters: { priceMax: 25_000 },
      }),
    );

    expect(rentals.listings.map((l) => l.slug)).toEqual(['rental']);
  });

  it('walks pages with a keyset cursor and repeats nothing', async () => {
    for (let n = 0; n < 9; n += 1) {
      await publish({ slug: `page-${String(n)}`, metersAway: 200 + n * 50 });
    }

    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 5; page += 1) {
      const result = ok(
        await searchListings({
          office: OFFICE,
          radiusMeters: 3000,
          limit: 4,
          ...(cursor ? { cursor } : {}),
        }),
      );
      seen.push(...result.listings.map((l) => l.slug));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
  });

  it('filters to one ring without changing the radius', async () => {
    await publish({ slug: 'r1', metersAway: 500 });
    await publish({ slug: 'r2', metersAway: 1_600 });

    const result = ok(
      await searchListings({
        office: OFFICE,
        radiusMeters: 3000,
        filters: { ring: 2 },
      }),
    );

    expect(result.listings.map((l) => l.slug)).toEqual(['r2']);
    // The counts still describe the whole radius, so the ring chips stay usable.
    expect(result.ringCounts).toEqual({ 1: 1, 2: 1, 3: 0 });
  });
});

describe('search URL state', () => {
  const roundTrip = (input: Record<string, string>): SearchQuery => {
    const parsed = parseSearchQuery(input);
    return parseSearchQuery(Object.fromEntries(buildSearchParams(parsed)));
  };

  it('survives a parse and rebuild unchanged', () => {
    const input = {
      lat: '25.612700',
      lng: '85.114500',
      radius: '2000',
      type: 'RENT',
      property: 'APARTMENT,VILLA',
      furnishing: 'SEMI_FURNISHED',
      priceMin: '8000',
      priceMax: '25000',
      bedsMin: '2',
      verified: 'true',
      sort: 'price_asc',
      q: 'boring road',
    };

    expect(roundTrip(input)).toEqual(parseSearchQuery(input));
  });

  it('leaves defaults out of the URL', () => {
    const params = buildSearchParams(
      parseSearchQuery({ lat: '25.6127', lng: '85.1145', radius: '3000', sort: 'distance' }),
    );

    // A URL that spells out every default is unreadable, and a shared link
    // should show what was actually chosen.
    expect(params.has('radius')).toBe(false);
    expect(params.has('sort')).toBe(false);
    expect(params.get('lat')).toBe('25.612700');
  });

  it('drops a cleared input rather than failing on it', () => {
    // A cleared number field leaves `?priceMax=` behind. That means "no
    // maximum", not "invalid".
    const query = parseSearchQuery({ lat: '25.6127', lng: '85.1145', priceMax: '' });

    expect(query.priceMax).toBeUndefined();
  });

  it('rejects an unknown enum value in a comma list', () => {
    expect(() => parseSearchQuery({ property: 'APARTMENT,CASTLE' })).toThrow();
  });

  it('has no search to run without an office', () => {
    expect(searchQueryToInput(parseSearchQuery({ type: 'RENT' }))).toBeNull();
  });

  it('keeps page size out of the URL', () => {
    const params = buildSearchParams(
      parseSearchQuery({ lat: '25.6127', lng: '85.1145', limit: '100' }),
    );

    expect(params.has('limit')).toBe(false);
  });
});

describe('saved offices', () => {
  it('makes the first office the default whether or not asked', async () => {
    const office = await createOffice(world.ownerSession, {
      label: 'Work',
      address: 'Boring Road, Patna',
      ...OFFICE,
    });

    // An account with offices and no default has no sensible starting view.
    expect(office.isDefault).toBe(true);
  });

  it('keeps exactly one default when another is promoted', async () => {
    const first = await createOffice(world.ownerSession, {
      label: 'Work',
      address: 'A',
      ...OFFICE,
    });
    const second = await createOffice(world.ownerSession, {
      label: 'Client site',
      address: 'B',
      ...offsetBy(2_000),
    });

    await patchOffice(world.ownerSession, second.id, { isDefault: true });
    const { offices } = await listOffices(world.ownerSession);

    expect(offices.filter((o) => o.isDefault).map((o) => o.id)).toEqual([second.id]);
    expect(offices.find((o) => o.id === first.id)?.isDefault).toBe(false);
  });

  it('promotes a survivor when the default is deleted', async () => {
    const first = await createOffice(world.ownerSession, {
      label: 'Work',
      address: 'A',
      ...OFFICE,
    });
    await createOffice(world.ownerSession, {
      label: 'Other',
      address: 'B',
      ...offsetBy(2_000),
    });

    await deleteOffice(world.ownerSession, first.id);
    const { offices } = await listOffices(world.ownerSession);

    expect(offices).toHaveLength(1);
    expect(offices[0]?.isDefault).toBe(true);
  });

  it('does not leak another user’s offices', async () => {
    await createOffice(world.ownerSession, { label: 'Mine', address: 'A', ...OFFICE });

    const { offices } = await listOffices(world.strangerSession);

    expect(offices).toHaveLength(0);
  });

  it('404s rather than 403s on someone else’s office', async () => {
    const mine = await createOffice(world.ownerSession, {
      label: 'Mine',
      address: 'A',
      ...OFFICE,
    });

    // Whether an office id exists is not a stranger's business.
    await expect(
      patchOffice(world.strangerSession, mine.id, { label: 'Theirs' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('is not overridable by an admin, unlike listings', async () => {
    const mine = await createOffice(world.ownerSession, {
      label: 'Mine',
      address: 'A',
      ...OFFICE,
    });

    // An office is somebody's workplace address. Moderation has no business
    // editing one, so there is deliberately no admin path here.
    await expect(deleteOffice(world.adminSession, mine.id)).rejects.toMatchObject({ status: 404 });
  });

  it('rejects a blank label with a message a form can show', async () => {
    await expect(
      createOffice(world.ownerSession, { label: '   ', address: 'A', ...OFFICE }),
    ).rejects.toThrow(/name/i);
  });
});
