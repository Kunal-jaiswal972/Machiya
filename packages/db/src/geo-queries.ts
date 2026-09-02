/**
 * Every line of raw SQL in this codebase lives in this file.
 *
 * Rules that hold here without exception:
 *  - coordinates, radii and filter values are BOUND PARAMETERS. Nothing is
 *    interpolated into SQL text. `Prisma.raw` appears only for sort directions
 *    and comparison operators chosen from closed whitelists in this module.
 *  - filters compose into ONE statement. Nothing fetches a superset and filters
 *    it in JavaScript.
 *  - inputs are Zod-validated going in and rows are Zod-parsed coming out, so a
 *    schema change that breaks a query fails loudly here instead of surfacing as
 *    undefined fields three layers up.
 */
import {
  RING_RADII_METERS,
  listingSearchInputSchema,
  listingSummarySchema,
  type Coordinate,
  type ListingSearchInput,
  type ListingSearchOptions,
  type ListingSearchResult,
  type ListingSort,
  type ListingSummary,
  type Ring,
} from '@machiya/shared';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { prisma } from './client.js';

const RING_1 = RING_RADII_METERS[0];
const RING_2 = RING_RADII_METERS[1];

/** A geography point built from bound lng/lat — never string-interpolated. */
function point(coordinate: Coordinate): Prisma.Sql {
  return Prisma.sql`ST_SetSRID(ST_MakePoint(${coordinate.lng}::double precision, ${coordinate.lat}::double precision), 4326)::geography`;
}

/**
 * Effective price for a row: rent for rentals, sale price for sales. Comparing a
 * monthly rent against a purchase price in a single range would be meaningless,
 * so the column is chosen per row rather than per query.
 */
const PRICE_EXPR = Prisma.sql`(CASE WHEN l."listingType" = 'RENT' THEN l."rentAmount" ELSE l."salePrice" END)`;

const cursorPayloadSchema = z.object({
  /** Sort key of the last row on the previous page. */
  v: z.number(),
  id: z.string().min(1),
});

type CursorPayload = z.infer<typeof cursorPayloadSchema>;

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Malformed pagination cursor');
  }

  const result = cursorPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error('Malformed pagination cursor');
  }
  return result.data;
}

/**
 * Every filter except the radius predicate and the ring, which depend on the
 * computed distance and are therefore applied outside the CTE.
 */
function buildFilterConditions(options: {
  filters: ListingSearchOptions['filters'];
  statuses: readonly string[];
}): Prisma.Sql[] {
  const { filters } = options;
  const conditions: Prisma.Sql[] = [
    Prisma.sql`l."status"::text = ANY(${options.statuses as string[]})`,
  ];

  if (filters.listingType) {
    conditions.push(Prisma.sql`l."listingType"::text = ${filters.listingType}`);
  }

  if (filters.propertyType?.length) {
    conditions.push(Prisma.sql`l."propertyType"::text = ANY(${filters.propertyType})`);
  }

  if (filters.furnishing?.length) {
    conditions.push(Prisma.sql`l."furnishing"::text = ANY(${filters.furnishing})`);
  }

  if (filters.priceMin !== undefined) {
    conditions.push(Prisma.sql`${PRICE_EXPR} >= ${filters.priceMin}`);
  }

  if (filters.priceMax !== undefined) {
    conditions.push(Prisma.sql`${PRICE_EXPR} <= ${filters.priceMax}`);
  }

  if (filters.bedroomsMin !== undefined) {
    conditions.push(Prisma.sql`l."bedrooms" >= ${filters.bedroomsMin}`);
  }

  if (filters.bedroomsMax !== undefined) {
    conditions.push(Prisma.sql`l."bedrooms" <= ${filters.bedroomsMax}`);
  }

  if (filters.bathroomsMin !== undefined) {
    conditions.push(Prisma.sql`l."bathrooms" >= ${filters.bathroomsMin}`);
  }

  if (filters.areaSqftMin !== undefined) {
    conditions.push(Prisma.sql`l."areaSqft" >= ${filters.areaSqftMin}`);
  }

  if (filters.areaSqftMax !== undefined) {
    conditions.push(Prisma.sql`l."areaSqft" <= ${filters.areaSqftMax}`);
  }

  if (filters.availableBy) {
    // No availableFrom means available now, so such a listing always qualifies.
    conditions.push(
      Prisma.sql`(l."availableFrom" IS NULL OR l."availableFrom" <= ${filters.availableBy})`,
    );
  }

  if (filters.verifiedOnly) {
    conditions.push(Prisma.sql`l."isVerified" = true`);
  }

  if (filters.citySlug) {
    conditions.push(
      Prisma.sql`l."cityId" = (SELECT "id" FROM "City" WHERE "slug" = ${filters.citySlug})`,
    );
  }

  if (filters.query) {
    // ILIKE, served by the pg_trgm GIN indexes on title and address.
    const pattern = `%${filters.query}%`;
    conditions.push(Prisma.sql`(l."title" ILIKE ${pattern} OR l."address" ILIKE ${pattern})`);
  }

  if (filters.amenitySlugs?.length) {
    // ALL of the selected amenities, not any of them.
    conditions.push(Prisma.sql`(
      SELECT count(DISTINCT a."slug")
      FROM "ListingAmenity" la
      JOIN "Amenity" a ON a."id" = la."amenityId"
      WHERE la."listingId" = l."id" AND a."slug" = ANY(${filters.amenitySlugs})
    ) = ${filters.amenitySlugs.length}`);
  }

  return conditions;
}

interface SortPlan {
  /** Expression aliased as "sortKey" in the CTE. Always a double precision. */
  keyExpr: Prisma.Sql;
  direction: 'ASC' | 'DESC';
  /** Keyset comparison operator that walks in the same direction. */
  comparison: '<' | '>';
}

/**
 * The only place a sort direction or comparison operator reaches SQL, and both
 * come from this closed set.
 */
function sortPlan(sort: ListingSort, distanceExpr: Prisma.Sql): SortPlan {
  switch (sort) {
    case 'price_asc':
      // A null price sorts last by mapping it to the top of the int range.
      return {
        keyExpr: Prisma.sql`COALESCE(${PRICE_EXPR}, 2147483647)::double precision`,
        direction: 'ASC',
        comparison: '>',
      };
    case 'price_desc':
      return {
        keyExpr: Prisma.sql`COALESCE(${PRICE_EXPR}, -1)::double precision`,
        direction: 'DESC',
        comparison: '<',
      };
    case 'newest':
      return {
        keyExpr: Prisma.sql`EXTRACT(EPOCH FROM COALESCE(l."publishedAt", l."createdAt"))::double precision`,
        direction: 'DESC',
        comparison: '<',
      };
    case 'distance':
      return { keyExpr: distanceExpr, direction: 'ASC', comparison: '>' };
  }
}

const searchRowSchema = listingSummarySchema.extend({ sortKey: z.number() });

/**
 * Radius search from the office — the single query behind the map, the result
 * list and every filter control.
 *
 * `ST_DWithin` against the GiST-indexed geography column does the bounding, and
 * the straight-line `ST_Distance` plus the ring are computed in the same pass so
 * the client never derives either. Road distance and duration are a separate
 * concern served by OSRM.
 */
export async function searchListingsInRadius(
  input: ListingSearchInput,
): Promise<ListingSearchResult> {
  const options = listingSearchInputSchema.parse(input);
  const origin = point(options.office);
  const distanceExpr = Prisma.sql`ST_Distance(l."location", ${origin})`;
  const plan = sortPlan(options.sort, distanceExpr);

  const conditions = buildFilterConditions({
    filters: options.filters,
    statuses: options.statuses,
  });
  conditions.push(Prisma.sql`ST_DWithin(l."location", ${origin}, ${options.radiusMeters})`);

  const base = Prisma.sql`
    SELECT
      l."id",
      l."slug",
      l."title",
      l."listingType"::text AS "listingType",
      l."propertyType"::text AS "propertyType",
      l."status"::text AS "status",
      l."furnishing"::text AS "furnishing",
      l."locality",
      l."lat",
      l."lng",
      l."bedrooms",
      l."bathrooms",
      l."areaSqft",
      l."rentAmount",
      l."salePrice",
      l."maintenanceMonthly",
      l."isVerified",
      (
        SELECT li."objectKey"
        FROM "ListingImage" li
        WHERE li."listingId" = l."id"
        ORDER BY li."isCover" DESC, li."sortOrder" ASC
        LIMIT 1
      ) AS "coverImageKey",
      ${distanceExpr} AS "distanceMeters",
      (CASE
        WHEN ${distanceExpr} <= ${RING_1} THEN 1
        WHEN ${distanceExpr} <= ${RING_2} THEN 2
        ELSE 3
      END) AS "ring",
      ${plan.keyExpr} AS "sortKey"
    FROM "Listing" l
    WHERE ${Prisma.join(conditions, ' AND ')}
  `;

  const outer: Prisma.Sql[] = [];

  if (options.filters.ring) {
    outer.push(Prisma.sql`"ring" = ${options.filters.ring}`);
  }

  if (options.cursor) {
    const cursor = decodeCursor(options.cursor);
    // Row-constructor keyset: strictly cheaper and more correct than OFFSET, and
    // stable while listings are being published underneath the user.
    outer.push(
      Prisma.sql`("sortKey", "id") ${Prisma.raw(plan.comparison)} (${cursor.v}::double precision, ${cursor.id})`,
    );
  }

  const outerWhere = outer.length ? Prisma.sql`WHERE ${Prisma.join(outer, ' AND ')}` : Prisma.empty;
  const direction = Prisma.raw(plan.direction);

  const pageRows = await prisma.$queryRaw<unknown[]>(Prisma.sql`
    WITH base AS (${base})
    SELECT * FROM base
    ${outerWhere}
    ORDER BY "sortKey" ${direction}, "id" ${direction}
    LIMIT ${options.limit + 1}
  `);

  // Ring counts describe the whole filtered set and deliberately ignore the ring
  // filter, so the UI can show what picking each ring would give.
  const ringRows = await prisma.$queryRaw<Array<{ ring: number; count: number }>>(Prisma.sql`
    WITH base AS (${base})
    SELECT "ring", count(*)::int AS "count"
    FROM base
    GROUP BY "ring"
  `);

  const parsed = z.array(searchRowSchema).parse(pageRows);
  const hasMore = parsed.length > options.limit;
  const page = hasMore ? parsed.slice(0, options.limit) : parsed;
  const last = page.at(-1);

  const ringCounts = { 1: 0, 2: 0, 3: 0 } satisfies Record<Ring, number>;
  for (const row of ringRows) {
    if (row.ring === 1 || row.ring === 2 || row.ring === 3) {
      ringCounts[row.ring] = Number(row.count);
    }
  }

  const listings: ListingSummary[] = page.map(({ sortKey: _sortKey, ...listing }) => listing);

  return {
    listings,
    nextCursor: hasMore && last ? encodeCursor({ v: last.sortKey, id: last.id }) : null,
    ringCounts,
    total: ringCounts[1] + ringCounts[2] + ringCounts[3],
  };
}

const similarListingSchema = listingSummarySchema.omit({ ring: true });

export type SimilarListing = z.infer<typeof similarListingSchema>;

/**
 * Similar listings for the detail sidebar: nearest neighbours to a listing,
 * within the same listing type and a price band around it.
 *
 * Ordering uses the `<->` operator so PostGIS answers it as an index-assisted
 * KNN scan rather than sorting every candidate.
 *
 * KNN on its own has no notion of "too far" — without the ST_DWithin bound a
 * listing in another city 1,500 km away is a perfectly good nearest neighbour
 * once local matches run out, which is not what a reader of a "similar nearby"
 * strip means.
 */
export async function findSimilarListings(input: {
  listingId: string;
  limit?: number;
  /** Fraction either side of the subject's price. 0.25 means -25%..+25%. */
  priceBand?: number;
  /** Hard distance bound. Beyond this, nothing is "similar nearby". */
  maxDistanceMeters?: number;
}): Promise<SimilarListing[]> {
  const { listingId, limit, priceBand, maxDistanceMeters } = z
    .object({
      listingId: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(24).default(6),
      priceBand: z.coerce.number().min(0.05).max(1).default(0.25),
      maxDistanceMeters: z.coerce.number().int().min(100).max(50_000).default(10_000),
    })
    .parse(input);

  const rows = await prisma.$queryRaw<unknown[]>(Prisma.sql`
    WITH subject AS (
      SELECT
        "id",
        "location",
        "listingType",
        (CASE WHEN "listingType" = 'RENT' THEN "rentAmount" ELSE "salePrice" END) AS "price"
      FROM "Listing"
      WHERE "id" = ${listingId}
    )
    SELECT
      l."id",
      l."slug",
      l."title",
      l."listingType"::text AS "listingType",
      l."propertyType"::text AS "propertyType",
      l."status"::text AS "status",
      l."furnishing"::text AS "furnishing",
      l."locality",
      l."lat",
      l."lng",
      l."bedrooms",
      l."bathrooms",
      l."areaSqft",
      l."rentAmount",
      l."salePrice",
      l."maintenanceMonthly",
      l."isVerified",
      (
        SELECT li."objectKey"
        FROM "ListingImage" li
        WHERE li."listingId" = l."id"
        ORDER BY li."isCover" DESC, li."sortOrder" ASC
        LIMIT 1
      ) AS "coverImageKey",
      ST_Distance(l."location", s."location") AS "distanceMeters"
    FROM "Listing" l
    CROSS JOIN subject s
    WHERE l."id" <> s."id"
      AND l."status" = 'PUBLISHED'
      AND l."listingType" = s."listingType"
      AND ST_DWithin(l."location", s."location", ${maxDistanceMeters})
      AND (
        s."price" IS NULL
        OR (CASE WHEN l."listingType" = 'RENT' THEN l."rentAmount" ELSE l."salePrice" END)
             BETWEEN s."price" * (1 - ${priceBand}) AND s."price" * (1 + ${priceBand})
      )
    ORDER BY l."location" <-> s."location"
    LIMIT ${limit}
  `);

  return z.array(similarListingSchema).parse(rows);
}

/**
 * Straight-line distance in metres. Road distance comes from OSRM — this is for
 * ring maths and sanity checks, never for commute cost.
 */
export async function straightLineDistanceMeters(
  from: Coordinate,
  to: Coordinate,
): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ meters: number }>>(
    Prisma.sql`SELECT ST_Distance(${point(from)}, ${point(to)}) AS "meters"`,
  );

  const meters = rows[0]?.meters;
  if (meters === undefined) {
    throw new Error('ST_Distance returned no rows');
  }
  return Number(meters);
}
