import { prisma, resolveCoverage } from '@machiya/db';
import { CITIES, cityBySlug, padBbox } from '@machiya/shared/cities';
import { coverageMessage, coverageRequestResponseSchema, coverageSetSchema } from '@machiya/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { assertCovered, checkCoverage, coverageSet } from '../src/services/coverage.js';
import { createDraft } from '../src/services/listings.js';
import { searchListings } from '../src/services/search.js';
import { reversePlace } from '../src/services/places.js';
import type { RequestSession } from '../src/middleware/require-auth.js';

/**
 * Coverage, against real PostGIS and the real city config.
 *
 * Nothing here is mocked, and that is the point: what is under test is a
 * `ST_Intersects` against a collection of envelopes plus an `ST_Covers` against
 * a `geography(MultiPolygon)` column Prisma cannot even SELECT. A stub would
 * assert only that the TypeScript branches line up, which is the half that was
 * never wrong.
 *
 * The three cities come from `CITIES`, not from literals, so a fourth city
 * added to the config widens these assertions with it — that is one of the
 * things correction 9 claims and this is what makes it checkable.
 */

/** Central Mumbai. A thousand kilometres from anything this product serves. */
const MUMBAI = { lat: 19.076, lng: 72.8777 };
/** Koramangala, well inside Bengaluru. */
const KORAMANGALA = { lat: 12.9352, lng: 77.6245 };

function sessionFor(id: string): RequestSession {
  return {
    userId: id,
    role: 'EDITOR',
    email: 'lister@test.local',
    user: {
      id,
      email: 'lister@test.local',
      name: 'Lister',
      emailVerified: true,
      role: 'EDITOR',
      banned: false,
    },
  } as RequestSession;
}

let session: RequestSession;

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "ListingAmenity", "ListingImage", "ListingView", "Favorite",
      "EnquiryMessage", "Enquiry", "SavedSearch", "FuelPrice", "CoverageRequest",
      "Listing", "OfficeLocation", "Amenity", "Locality", "Session", "Account",
      "User", "City" RESTART IDENTITY CASCADE
  `);

  // Every configured city, with its real boundary where one has been derived —
  // the same rows the seed writes, because the boundary is what containment
  // tests against.
  for (const city of CITIES) {
    const row = await prisma.city.create({
      data: {
        slug: city.slug,
        name: city.name,
        state: city.state,
        centroidLat: city.centroid.lat,
        centroidLng: city.centroid.lng,
        bbox: city.bbox,
      },
      select: { id: true },
    });

    if (city.boundary) {
      await prisma.$executeRaw`
        UPDATE "City"
        SET "boundary" = ST_Multi(ST_MakeValid(ST_GeomFromGeoJSON(${JSON.stringify({
          type: city.boundary.type,
          coordinates: city.boundary.coordinates,
        })}::json)))::geography
        WHERE "id" = ${row.id}
      `;
    }
  }

  const user = await prisma.user.create({
    data: { email: 'lister@test.local', name: 'Lister', role: 'EDITOR', emailVerified: true },
  });
  session = sessionFor(user.id);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the coverage frontier', () => {
  it('covers a point well inside a city', async () => {
    const resolution = await checkCoverage(KORAMANGALA);

    expect(resolution.covered).toBe(true);
    if (resolution.covered) {
      expect(resolution.city.slug).toBe('bengaluru');
    }
  });

  it('does NOT cover Mumbai, and names the nearest served city', async () => {
    const resolution = await checkCoverage(MUMBAI);

    expect(resolution.covered).toBe(false);
    // Pune is about 120 km from Mumbai; Patna and Bengaluru are both far
    // further. Asserted as an ordering rather than a slug so the test survives
    // a boundary re-derivation.
    expect(resolution.nearest?.slug).toBe('pune');
    expect(resolution.nearest?.distanceMeters).toBeGreaterThan(100_000);
  });

  it('covers a point in the PADDED margin, outside the administrative bbox', async () => {
    // The 9 km ring D47 added. Inside coverage — a route from here has to be
    // answerable — but outside the box locality validation uses. Conflating
    // the two boxes is the bug the padded/unpadded split exists to prevent.
    const bengaluru = cityBySlug('bengaluru');
    const justOutside = {
      lat: bengaluru.bbox.maxLat + 0.04,
      lng: (bengaluru.bbox.minLng + bengaluru.bbox.maxLng) / 2,
    };

    expect(justOutside.lat).toBeGreaterThan(bengaluru.bbox.maxLat);
    expect(justOutside.lat).toBeLessThan(bengaluru.paddedBbox.maxLat);

    const resolution = await checkCoverage(justOutside);
    expect(resolution.covered).toBe(true);
  });

  it('treats the frontier as a union of boxes, not their bounding rectangle', async () => {
    // Nagpur: inside the rectangle that encloses Patna, Bengaluru and Pune, and
    // inside none of them. Testing membership against `bboxUnion` rather than
    // per-box would declare most of central India covered and then fail every
    // downstream call.
    const nagpur = { lat: 21.1458, lng: 79.0882 };
    const bounds = coverageSet().maxBounds;

    expect(nagpur.lat).toBeGreaterThan(bounds.minLat);
    expect(nagpur.lat).toBeLessThan(bounds.maxLat);
    expect(nagpur.lng).toBeGreaterThan(bounds.minLng);
    expect(nagpur.lng).toBeLessThan(bounds.maxLng);

    const resolution = await checkCoverage(nagpur);
    expect(resolution.covered).toBe(false);
  });

  it('resolves a point in a GAP between boundaries to a city, still inside coverage', async () => {
    // Correction 9's most important distinction. Nearest-centroid inside
    // coverage is correct — it is a point in the margin between a municipal
    // polygon and the edge of the extract — and across the frontier it is
    // silent data corruption. Same arithmetic, opposite verdict.
    const patna = cityBySlug('patna');
    const inTheGap = {
      lat: patna.bbox.maxLat + 0.05,
      lng: (patna.bbox.minLng + patna.bbox.maxLng) / 2,
    };

    const resolution = await resolveCoverage(inTheGap, [patna.paddedBbox]);

    expect(resolution.covered).toBe(true);
    if (resolution.covered) {
      expect(resolution.city.slug).toBe('patna');
      expect(resolution.method).toBe('nearest');
      expect(resolution.distanceMeters).toBeGreaterThan(0);
    }
  });

  it('refuses everything when no box has been cut', async () => {
    // No artifacts means no coverage, rather than "everything is covered".
    const resolution = await resolveCoverage(KORAMANGALA, []);

    expect(resolution.covered).toBe(false);
  });

  it('does not treat a box for one city as coverage for another', async () => {
    const resolution = await resolveCoverage(KORAMANGALA, [cityBySlug('patna').paddedBbox]);

    expect(resolution.covered).toBe(false);
  });
});

describe('the coverage set', () => {
  it('reflects the CONFIGURED cities, not a literal list', () => {
    const set = coverageSet();

    expect(set.cities.map((city) => city.slug).sort()).toEqual(
      CITIES.map((city) => city.slug).sort(),
    );
    expect(set.cities).toHaveLength(CITIES.length);
  });

  it('carries each city its centroid, both boxes and its boundary', () => {
    const bengaluru = coverageSet().cities.find((city) => city.slug === 'bengaluru');
    const configured = cityBySlug('bengaluru');

    expect(bengaluru?.centroid).toEqual(configured.centroid);
    expect(bengaluru?.bbox).toEqual(configured.bbox);
    expect(bengaluru?.paddedBbox).toEqual(padBbox(configured.bbox));
    expect(bengaluru?.boundary?.type).toMatch(/^(Polygon|MultiPolygon)$/);
  });

  it('derives maxBounds so it encloses every padded box', () => {
    const bounds = coverageSet().maxBounds;

    for (const city of CITIES) {
      expect(bounds.minLng).toBeLessThanOrEqual(city.paddedBbox.minLng);
      expect(bounds.minLat).toBeLessThanOrEqual(city.paddedBbox.minLat);
      expect(bounds.maxLng).toBeGreaterThanOrEqual(city.paddedBbox.maxLng);
      expect(bounds.maxLat).toBeGreaterThanOrEqual(city.paddedBbox.maxLat);
    }
  });
});

describe('search out of coverage', () => {
  it('returns out_of_coverage rather than an empty result set', async () => {
    const result = await searchListings({ office: MUMBAI, sort: 'distance' });

    expect(result.status).toBe('out_of_coverage');
    if (result.status === 'out_of_coverage') {
      expect(result.coverage.supportedCities.map((city) => city.name)).toEqual(
        CITIES.map((city) => city.name),
      );
      expect(result.coverage.nearest?.name).toBe('Pune');
      expect(coverageMessage(result.coverage)).toMatch(/^Machiya covers .*Pune is nearest, \d+ km/);
    }
  });

  it('has no `total` field to misread as zero results', async () => {
    const result = await searchListings({ office: MUMBAI, sort: 'distance' });

    // The union is what makes this impossible to get wrong in a caller: there
    // is no `total: 0` sitting next to a coverage payload.
    expect(result).not.toHaveProperty('total');
    expect(result).not.toHaveProperty('listings');
  });

  it('runs the query normally inside coverage', async () => {
    const result = await searchListings({ office: KORAMANGALA, sort: 'distance' });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.total).toBe(0);
      expect(result.ringCounts).toEqual({ 1: 0, 2: 0, 3: 0 });
    }
  });
});

describe('reverse geocode out of coverage', () => {
  it('carries the coverage payload rather than a bare null place', async () => {
    const result = await reversePlace(MUMBAI);

    expect(result.place).toBeNull();
    expect(result.coverage?.nearest?.slug).toBe('pune');
    // Echoed back so the capture form knows which point was asked about.
    expect(result.coverage?.requested).toEqual(MUMBAI);
  });
});

describe('listing creation out of coverage', () => {
  const draft = {
    citySlug: 'pune',
    title: 'Sea-facing 2BHK in Bandra',
    description: 'A flat in a city this product does not serve.',
    listingType: 'RENT' as const,
    propertyType: 'APARTMENT' as const,
    furnishing: 'SEMI_FURNISHED' as const,
    address: 'Hill Road, Bandra West',
    locality: 'Bandra',
    bedrooms: 2,
    bathrooms: 2,
    areaSqft: 900,
    rentAmount: 85_000,
    amenitySlugs: [],
    rules: [],
  };

  it('is rejected with a 422, not filed under the nearest city', async () => {
    await expect(
      createDraft(session, { ...draft, lat: MUMBAI.lat, lng: MUMBAI.lng }),
    ).rejects.toMatchObject({ status: 422, code: 'out_of_coverage' });

    // The point of the test: no row. Before correction 9 this created a listing
    // filed under Pune, 120 km away, invisible in every search anyone would run
    // for it and perfectly healthy-looking in the database.
    expect(await prisma.listing.count()).toBe(0);
  });

  it('carries the served cities in the error body, for the wizard', async () => {
    const error = await createDraft(session, {
      ...draft,
      lat: MUMBAI.lat,
      lng: MUMBAI.lng,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const body = (error as { body: () => { coverage?: { supportedCities: unknown[] } } }).body();
    expect(body.coverage?.supportedCities).toHaveLength(CITIES.length);
  });

  it('accepts a listing inside coverage', async () => {
    const listing = await createDraft(session, {
      ...draft,
      citySlug: 'bengaluru',
      title: 'Quiet 2BHK in Koramangala',
      locality: 'Koramangala',
      address: '5th Block, Koramangala',
      lat: KORAMANGALA.lat,
      lng: KORAMANGALA.lng,
    });

    expect(listing.slug).toContain('bengaluru-');
    await prisma.listing.delete({ where: { id: listing.id } });
  });
});

describe('assertCovered', () => {
  it('returns the resolved city so a caller never resolves twice', async () => {
    const city = await assertCovered(KORAMANGALA);

    expect(city.slug).toBe('bengaluru');
    expect(city.method).toBe('covers');
  });
});

/**
 * The public endpoint, over HTTP.
 *
 * `coverageSet()` is already covered above; what these add is the wire
 * contract — the status codes, the cache headers a rebuild has to be able to
 * invalidate, and the refusal to record a request for a city we already serve.
 */
describe('GET /api/coverage', () => {
  const app = () =>
    createApp({
      requestLogging: false,
      corsOrigins: ['http://localhost:5173'],
      mountAuth: false,
      probes: {
        database: async () => ({ ok: true, postgisVersion: '3.4.2' }),
        redis: async () => ({ ok: true, detail: 'PONG' }),
      },
    });

  it('serves the configured cities with an epoch-stamped ETag', async () => {
    const response = await request(await app()).get('/api/coverage');

    expect(response.status).toBe(200);
    const body = coverageSetSchema.parse(response.body);
    expect(body.cities.map((city) => city.slug).sort()).toEqual(
      CITIES.map((city) => city.slug).sort(),
    );
    // Cached hard, because it changes only on a rebuild — and the ETag carries
    // the epoch, which is exactly what a rebuild moves.
    expect(response.headers['cache-control']).toContain('max-age');
    expect(response.headers.etag).toContain(body.epoch);
  });

  it('records a request for an uncovered point and reports the count back', async () => {
    const response = await request(await app())
      .post('/api/coverage/requests')
      .send({ email: 'someone@example.com', ...MUMBAI, placeLabel: 'Bandra West' });

    expect(response.status).toBe(201);
    expect(coverageRequestResponseSchema.parse(response.body).requests).toBe(1);

    const row = await prisma.coverageRequest.findFirstOrThrow({
      where: { email: 'someone@example.com' },
    });
    // Rounded to about 110 m before storage, so one person tapping three
    // slightly different pins is one row rather than three votes.
    expect(row.lat).toBe(19.076);
    expect(row.lng).toBe(72.878);
    expect(row.placeLabel).toBe('Bandra West');
  });

  it('counts a second person nearby rather than a second tap', async () => {
    const send = async (email: string, point: { lat: number; lng: number }) =>
      request(await app())
        .post('/api/coverage/requests')
        .send({ email, ...point });

    // Same person, a pin moved 300 m: still one row, `asks` incremented, and
    // the count they see does not go up — because it counts people, not taps.
    const again = await send('someone@example.com', { lat: 19.079, lng: 72.879 });
    expect(again.status).toBe(201);
    expect(coverageRequestResponseSchema.parse(again.body).requests).toBe(1);

    // Thane, 30 km away — the same metro, a different person.
    const other = await send('another@example.com', { lat: 19.2183, lng: 72.9781 });
    expect(coverageRequestResponseSchema.parse(other.body).requests).toBe(2);
  });

  it('refuses a request for a city it already covers', async () => {
    const response = await request(await app())
      .post('/api/coverage/requests')
      .send({ email: 'someone@example.com', ...KORAMANGALA });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('already_covered');
  });
});
