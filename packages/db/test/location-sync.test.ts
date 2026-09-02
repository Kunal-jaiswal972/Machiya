import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/client.js';
import { PATNA_OFFICE, north, seedFixtures } from './fixtures.js';

let ownerId: string;
let cityId: string;

beforeAll(async () => {
  const seeded = await seedFixtures();
  ownerId = seeded.ownerId;
  cityId = seeded.cityIds.patna;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Reads the geography column, which Prisma itself cannot select. */
async function readLocation(listingId: string) {
  const rows = await prisma.$queryRaw<Array<{ lng: number; lat: number; srid: number }>>`
    SELECT ST_X("location"::geometry) AS lng,
           ST_Y("location"::geometry) AS lat,
           ST_SRID("location"::geometry) AS srid
    FROM "Listing"
    WHERE "id" = ${listingId}
  `;
  return rows[0];
}

async function createListing(lat: number, lng: number, slug: string) {
  return prisma.listing.create({
    data: {
      slug,
      ownerId,
      cityId,
      title: 'Trigger probe',
      description: 'Trigger probe',
      listingType: 'RENT',
      propertyType: 'APARTMENT',
      status: 'DRAFT',
      address: 'Somewhere, Patna',
      locality: 'Somewhere',
      lat,
      lng,
      bedrooms: 1,
      bathrooms: 1,
      areaSqft: 500,
      furnishing: 'UNFURNISHED',
      rentAmount: 10_000,
    },
  });
}

describe('machiya_sync_location trigger', () => {
  it('derives location from lat/lng on insert, with lng as X', async () => {
    const created = await createListing(25.6, 85.14, 'trigger-insert');
    const location = await readLocation(created.id);

    expect(location).toBeDefined();
    expect(location?.lng).toBeCloseTo(85.14, 9);
    expect(location?.lat).toBeCloseTo(25.6, 9);
    expect(location?.srid).toBe(4326);
  });

  it('rewrites location when lat/lng change', async () => {
    const created = await createListing(25.6, 85.14, 'trigger-update');
    const moved = north(PATNA_OFFICE, 2_000);

    await prisma.listing.update({
      where: { id: created.id },
      data: { lat: moved.lat, lng: moved.lng },
    });

    const location = await readLocation(created.id);
    expect(location?.lat).toBeCloseTo(moved.lat, 9);
    expect(location?.lng).toBeCloseTo(moved.lng, 9);
  });

  it('leaves location alone when an unrelated column is updated', async () => {
    const created = await createListing(25.61, 85.15, 'trigger-untouched');
    const before = await readLocation(created.id);

    await prisma.listing.update({ where: { id: created.id }, data: { title: 'Renamed' } });

    const after = await readLocation(created.id);
    expect(after?.lat).toBeCloseTo(before?.lat ?? 0, 12);
    expect(after?.lng).toBeCloseTo(before?.lng ?? 0, 12);
  });

  it('rejects an out-of-range latitude instead of storing a broken point', async () => {
    await expect(createListing(95, 85.14, 'trigger-bad-lat')).rejects.toThrow(/lat out of range/);
  });

  it('rejects an out-of-range longitude', async () => {
    await expect(createListing(25.6, 200, 'trigger-bad-lng')).rejects.toThrow(/lng out of range/);
  });

  it('populates location for every seeded fixture row', async () => {
    const rows = await prisma.$queryRaw<Array<{ missing: bigint }>>`
      SELECT count(*) AS missing FROM "Listing" WHERE "location" IS NULL
    `;
    expect(Number(rows[0]?.missing ?? -1)).toBe(0);
  });
});

describe('location NOT NULL is enforced by a CHECK constraint', () => {
  it('has the constraint on both geo tables', async () => {
    const rows = await prisma.$queryRaw<Array<{ conname: string; definition: string }>>`
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE contype = 'c'
        AND conname IN ('listing_location_present', 'office_location_present')
      ORDER BY conname
    `;

    expect(rows.map((row) => row.conname)).toEqual([
      'listing_location_present',
      'office_location_present',
    ]);
    expect(rows[0]?.definition).toMatch(/location IS NOT NULL/);
  });

  it('refuses a row whose location was nulled out behind the trigger', async () => {
    const created = await createListing(25.62, 85.16, 'check-constraint');

    // The trigger only fires on lat/lng, so this is the one way to reach the
    // constraint — and it must fail rather than leave an unsearchable row.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Listing" SET "location" = NULL WHERE "id" = $1`,
        created.id,
      ),
    ).rejects.toThrow(/listing_location_present/);
  });
});

describe('spatial indexes', () => {
  it('has a GiST index on both geography columns plus the published partial', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexdef ILIKE '%USING gist%'
      ORDER BY indexname
    `;

    const names = rows.map((row) => row.indexname);
    expect(names).toContain('listing_location_gix');
    expect(names).toContain('office_location_gix');
    expect(names).toContain('listing_location_published_gix');

    const partial = rows.find((row) => row.indexname === 'listing_location_published_gix');
    expect(partial?.indexdef).toMatch(/WHERE \(status = 'PUBLISHED'/);
  });

  it('can answer a radius search from the spatial index', async () => {
    // On a seven-row fixture table Postgres rightly prefers a sequential scan,
    // so seqscan is disabled for the duration of the plan to prove the index is
    // actually usable for ST_DWithin — which is the property that matters.
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>`
        EXPLAIN SELECT "id" FROM "Listing"
        WHERE ST_DWithin(
          "location",
          ST_SetSRID(ST_MakePoint(${PATNA_OFFICE.lng}, ${PATNA_OFFICE.lat}), 4326)::geography,
          3000
        )
      `;
    });

    const planText = plan.map((row) => row['QUERY PLAN']).join('\n');
    expect(planText).toMatch(/Index Scan|Bitmap Index Scan/);
  });
});
