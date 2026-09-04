import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/client.js';
import { resolveCityForPoint } from '../src/geo-queries.js';

/**
 * City assignment by containment, against real PostGIS.
 *
 * Mockable this is not: what is being tested is `ST_Covers` against a
 * `geography(MultiPolygon)` column that Prisma cannot even SELECT, plus the
 * ordering that picks between two overlapping polygons. A stubbed client would
 * assert nothing about any of it.
 *
 * The case that matters is the near-boundary one. Nearest-centroid assignment
 * is right for three cities 1,000 km apart and starts being wrong the moment
 * two cities are 150 km apart — so the fixtures below put two boxes 0.4° apart
 * and probe the strip between them. See DECISIONS.md D50.
 */

/** A square boundary, as GeoJSON, so the fixtures read as coordinates. */
function square(centre: { lat: number; lng: number }, halfDegrees: number): string {
  const { lat, lng } = centre;
  const h = halfDegrees;
  return JSON.stringify({
    type: 'Polygon',
    coordinates: [
      [
        [lng - h, lat - h],
        [lng + h, lat - h],
        [lng + h, lat + h],
        [lng - h, lat + h],
        [lng - h, lat - h],
      ],
    ],
  });
}

const WEST = { lat: 25.6, lng: 85.0 };
const EAST = { lat: 25.6, lng: 85.6 };
/** Neither city: 0.15° east of West's edge and 0.15° west of East's. */
const BETWEEN = { lat: 25.6, lng: 85.3 };

async function setBoundary(slug: string, geojson: string | null): Promise<void> {
  if (geojson === null) {
    await prisma.$executeRaw`UPDATE "City" SET "boundary" = NULL WHERE "slug" = ${slug}`;
    return;
  }

  await prisma.$executeRaw`
    UPDATE "City"
    SET "boundary" = ST_Multi(ST_MakeValid(ST_GeomFromGeoJSON(${geojson}::json)))::geography
    WHERE "slug" = ${slug}
  `;
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "ListingAmenity", "ListingImage", "ListingView", "Favorite",
      "EnquiryMessage", "Enquiry", "SavedSearch", "FuelPrice", "Listing",
      "OfficeLocation", "Amenity", "User", "City" RESTART IDENTITY CASCADE
  `);

  await prisma.city.create({
    data: {
      slug: 'westville',
      name: 'Westville',
      state: 'Bihar',
      centroidLat: WEST.lat,
      centroidLng: WEST.lng,
      bbox: { minLng: 84.85, minLat: 25.45, maxLng: 85.15, maxLat: 25.75 },
    },
  });

  await prisma.city.create({
    data: {
      slug: 'eastville',
      name: 'Eastville',
      state: 'Bihar',
      centroidLat: EAST.lat,
      centroidLng: EAST.lng,
      bbox: { minLng: 85.45, minLat: 25.45, maxLng: 85.75, maxLat: 25.75 },
    },
  });

  await setBoundary('westville', square(WEST, 0.15));
  await setBoundary('eastville', square(EAST, 0.15));
});

describe('resolveCityForPoint', () => {
  it('assigns a point inside a boundary to that city', async () => {
    const match = await resolveCityForPoint({ lat: 25.61, lng: 85.02 });

    expect(match?.slug).toBe('westville');
    expect(match?.method).toBe('covers');
  });

  it('assigns a point just INSIDE the far edge correctly, not to the nearer centroid', async () => {
    // 85.149 is inside Westville's boundary but 0.451° from its centroid and
    // 0.451° from Eastville's — the case where a rounding error in a
    // centroid comparison flips the answer. Containment does not have that
    // failure mode.
    const match = await resolveCityForPoint({ lat: 25.6, lng: 85.149 });

    expect(match?.slug).toBe('westville');
    expect(match?.method).toBe('covers');
  });

  it('assigns a point exactly ON the boundary, which ST_Contains would not', async () => {
    // A real address on a municipal border. ST_Covers includes the boundary;
    // ST_Contains excludes it and would push this to the centroid guess.
    const match = await resolveCityForPoint({ lat: 25.6, lng: 85.15 });

    expect(match?.slug).toBe('westville');
    expect(match?.method).toBe('covers');
  });

  it('falls back to the nearest centroid for a point in no city', async () => {
    const match = await resolveCityForPoint(BETWEEN);

    expect(match?.method).toBe('nearest');
    // Equidistant by construction, so either answer is defensible — what
    // matters is that it is LABELLED a guess rather than presented as fact.
    expect(['westville', 'eastville']).toContain(match?.slug);
    expect(match?.distanceMeters).toBeGreaterThan(0);
  });

  it('falls back for a city that has no boundary at all', async () => {
    await setBoundary('westville', null);

    const match = await resolveCityForPoint({ lat: 25.61, lng: 85.02 });

    expect(match?.slug).toBe('westville');
    // Right answer, wrong confidence — and the caller logs it, which is how a
    // never-generated boundary gets noticed.
    expect(match?.method).toBe('nearest');

    await setBoundary('westville', square(WEST, 0.15));
  });

  it('prefers the smaller polygon when two boundaries overlap', async () => {
    // Overlapping municipal polygons are what the city validator's overlap
    // check exists to prevent, but if one slips through the more specific
    // answer is the better one.
    await setBoundary('eastville', square(WEST, 0.4));

    const match = await resolveCityForPoint({ lat: 25.61, lng: 85.02 });

    expect(match?.slug).toBe('westville');
    expect(match?.method).toBe('covers');

    await setBoundary('eastville', square(EAST, 0.15));
  });

  it('rejects a boundary with no area', async () => {
    // The CHECK constraint from the migration, and the reason it is about AREA
    // rather than point counts: this polygon is well-formed, closed and
    // accepted by PostGIS — its four points are simply collinear. It would
    // store happily and then match nothing, sending every listing in the city
    // to the centroid guess with the column looking populated.
    await expect(
      prisma.$executeRawUnsafe(`
        UPDATE "City"
        SET "boundary" = ST_GeogFromText(
          'MULTIPOLYGON(((85 25, 85.1 25, 85.2 25, 85 25)))'
        )
        WHERE "slug" = 'eastville'
      `),
    ).rejects.toThrow(/city_boundary_has_area/i);
  });

  it('rejects an empty boundary', async () => {
    await expect(
      prisma.$executeRawUnsafe(`
        UPDATE "City"
        SET "boundary" = ST_GeogFromText('MULTIPOLYGON EMPTY')
        WHERE "slug" = 'eastville'
      `),
    ).rejects.toThrow(/city_boundary_has_area/i);
  });
});
