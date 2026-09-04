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
      -- READY only, and the VARIANT prefix rather than the original's key: the
      -- original is deleted once derivation succeeds, so selecting it gave every
      -- processed listing a null cover.
      cover."variantBaseKey" AS "coverVariantBase",
      cover."lqip" AS "coverLqip",
      cover."dominantColor" AS "coverDominantColor",
      ${distanceExpr} AS "distanceMeters",
      (CASE
        WHEN ${distanceExpr} <= ${RING_1} THEN 1
        WHEN ${distanceExpr} <= ${RING_2} THEN 2
        ELSE 3
      END) AS "ring",
      ${plan.keyExpr} AS "sortKey"
    FROM "Listing" l
    LEFT JOIN LATERAL (
      SELECT li."variantBaseKey", li."lqip", li."dominantColor"
      FROM "ListingImage" li
      WHERE li."listingId" = l."id" AND li."status" = 'READY'
      ORDER BY li."isCover" DESC, li."sortOrder" ASC
      LIMIT 1
    ) cover ON true
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
      -- READY only, and the VARIANT prefix rather than the original's key: the
      -- original is deleted once derivation succeeds, so selecting it gave every
      -- processed listing a null cover.
      cover."variantBaseKey" AS "coverVariantBase",
      cover."lqip" AS "coverLqip",
      cover."dominantColor" AS "coverDominantColor",
      ST_Distance(l."location", s."location") AS "distanceMeters"
    FROM "Listing" l
    CROSS JOIN subject s
    LEFT JOIN LATERAL (
      SELECT li."variantBaseKey", li."lqip", li."dominantColor"
      FROM "ListingImage" li
      WHERE li."listingId" = l."id" AND li."status" = 'READY'
      ORDER BY li."isCover" DESC, li."sortOrder" ASC
      LIMIT 1
    ) cover ON true
    WHERE l."id" <> s."id"
      AND l."status" = 'PUBLISHED'
      AND l."listingType" = s."listingType"
      AND ST_DWithin(l."location", s."location", ${maxDistanceMeters})
      AND (
        s."price" IS NULL
        OR (CASE WHEN l."listingType" = 'RENT' THEN l."rentAmount" ELSE l."salePrice" END)
             BETWEEN s."price" * (1 - ${priceBand}::double precision)
                 AND s."price" * (1 + ${priceBand}::double precision)
      )
    ORDER BY l."location" <-> s."location"
    LIMIT ${limit}
  `);

  return z.array(similarListingSchema).parse(rows);
}

// --- tier 1 of the autocomplete --------------------------------------------

/**
 * Local place search: city names, locality names, and the titles and addresses
 * of published listings, ranked by trigram similarity with a prefix boost.
 *
 * This is tier 1 of the two-tier autocomplete (D39). It answers most
 * office-selection queries in single-digit milliseconds with results that are
 * actually inside the three cities the product serves, and it needs no network.
 *
 * Two match paths, deliberately:
 *  - `%` (trigram similarity above the session threshold), which the GIN
 *    gin_trgm_ops indexes serve. This is what makes "koramangla" find
 *    Koramangala.
 *  - a case-insensitive prefix, which is what makes a two-character query work
 *    at all: `similarity('Koramangala', 'ko')` is about 0.18, well under any
 *    useful threshold, but "ko" is exactly how someone starts typing it.
 *
 * The prefix path scores 0.92 rather than 1.0 so an exact trigram match still
 * outranks it, and each kind carries a weight: a locality or city is a better
 * office answer than a listing whose title happens to contain the word.
 */
const placeRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  context: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  kind: z.enum(['city', 'locality', 'listing']),
  score: z.number(),
  citySlug: z.string().nullable(),
  listingSlug: z.string().nullable(),
  bbox: z.unknown().nullable(),
});

export type LocalPlaceRow = z.infer<typeof placeRowSchema>;

export async function searchPlacesLocally(input: {
  query: string;
  citySlug?: string;
  limit?: number;
}): Promise<LocalPlaceRow[]> {
  const { query, citySlug, limit } = z
    .object({
      query: z.string().min(1).max(120),
      citySlug: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(40).default(8),
    })
    .parse(input);

  const term = query.trim();
  if (term.length === 0) return [];

  const prefix = `${term.toLowerCase()}%`;
  const cityFilter = citySlug ?? null;

  // One statement, three sources. Nothing is fetched and filtered in JS, and
  // the term reaches SQL only as a bound parameter — the trigram operators are
  // literal text in the query, not interpolated input.
  const rows = await prisma.$queryRaw<unknown[]>(Prisma.sql`
    WITH scored AS (
      SELECT
        'city:' || c."id"          AS "id",
        c."name"                   AS "label",
        c."state"                  AS "context",
        c."centroidLat"            AS "lat",
        c."centroidLng"            AS "lng",
        'city'                     AS "kind",
        LEAST(
          1.0,
          GREATEST(
            similarity(c."name", ${term}),
            CASE WHEN lower(c."name") LIKE ${prefix} THEN 0.92 ELSE 0 END
          )
        )::double precision        AS "score",
        c."slug"                   AS "citySlug",
        NULL::text                 AS "listingSlug",
        c."bbox"                   AS "bbox"
      FROM "City" c
      WHERE (c."name" % ${term} OR lower(c."name") LIKE ${prefix})
        AND (${cityFilter}::text IS NULL OR c."slug" = ${cityFilter})

      UNION ALL

      SELECT
        'locality:' || l."id",
        l."name",
        c."name" || ', ' || c."state",
        l."lat",
        l."lng",
        'locality',
        LEAST(
          1.0,
          GREATEST(
            similarity(l."name", ${term}),
            CASE WHEN lower(l."name") LIKE ${prefix} THEN 0.92 ELSE 0 END
          )
        )::double precision,
        c."slug",
        NULL::text,
        NULL::jsonb
      FROM "Locality" l
      JOIN "City" c ON c."id" = l."cityId"
      WHERE (l."name" % ${term} OR lower(l."name") LIKE ${prefix})
        AND (${cityFilter}::text IS NULL OR c."slug" = ${cityFilter})

      UNION ALL

      SELECT
        'listing:' || li."id",
        li."title",
        li."locality" || ', ' || c."name",
        li."lat",
        li."lng",
        'listing',
        (LEAST(
          1.0,
          GREATEST(
            similarity(li."title", ${term}),
            similarity(li."address", ${term}),
            CASE
              WHEN lower(li."title") LIKE ${prefix} OR lower(li."address") LIKE ${prefix}
              THEN 0.92 ELSE 0
            END
          )
        ) * 0.8)::double precision,
        c."slug",
        li."slug",
        NULL::jsonb
      FROM "Listing" li
      JOIN "City" c ON c."id" = li."cityId"
      WHERE li."status" = 'PUBLISHED'
        AND (
          li."title" % ${term} OR li."address" % ${term}
          OR lower(li."title") LIKE ${prefix} OR lower(li."address") LIKE ${prefix}
        )
        AND (${cityFilter}::text IS NULL OR c."slug" = ${cityFilter})
    )
    SELECT * FROM scored
    WHERE "score" > 0
    ORDER BY "score" DESC, "label" ASC
    LIMIT ${limit}
  `);

  return z.array(placeRowSchema).parse(rows);
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

/**
 * Which city a point belongs to.
 *
 * `ST_Covers` against `City.boundary` first, nearest centroid second **with a
 * logged warning**. Nearest centroid alone was what step 5 did, and it misfiles
 * listings as cities multiply: with three cities 1,000 km apart the nearest
 * centroid is always right, and with a fourth city 150 km from an existing one
 * it stops being. Padded bboxes widen the ambiguous zone further (D47), which
 * is why the boundary is the primary test and the centroid only the fallback.
 *
 * `ST_Covers` rather than the `ST_Contains` the brief names: `ST_Contains` is
 * geometry-only, so it would mean casting a geography column and losing the
 * spheroidal semantics the rest of this file relies on. `ST_Covers` is the
 * geography-native equivalent and additionally treats a point exactly ON the
 * boundary as inside — which is the answer you want for an address on a
 * municipal border.
 *
 * The `method` in the result is not decoration: a `nearest` answer is a guess,
 * and every caller logs it so a systematically misfiled city shows up as a
 * pattern in the logs rather than as a support ticket. See DECISIONS.md D50.
 */
const cityMatchSchema = z.object({
  id: z.string(),
  slug: z.string(),
  method: z.enum(['covers', 'nearest']),
  distanceMeters: z.number(),
});

export type CityMatch = z.infer<typeof cityMatchSchema>;

export async function resolveCityForPoint(coordinate: Coordinate): Promise<CityMatch | null> {
  const covered = await prisma.$queryRaw<unknown[]>(Prisma.sql`
    SELECT
      c."id",
      c."slug",
      'covers' AS "method",
      0::double precision AS "distanceMeters"
    FROM "City" c
    WHERE c."boundary" IS NOT NULL
      AND ST_Covers(c."boundary", ${point(coordinate)})
    -- A point in two boundaries at once means overlapping municipal polygons,
    -- which the city validator's overlap check exists to prevent. Take the
    -- smallest: the more specific polygon is the better answer.
    ORDER BY ST_Area(c."boundary"::geometry) ASC
    LIMIT 1
  `);

  const hit = covered[0];
  if (hit) return cityMatchSchema.parse(hit);

  const nearest = await prisma.$queryRaw<unknown[]>(Prisma.sql`
    SELECT
      c."id",
      c."slug",
      'nearest' AS "method",
      ST_Distance(
        ST_SetSRID(ST_MakePoint(c."centroidLng"::double precision, c."centroidLat"::double precision), 4326)::geography,
        ${point(coordinate)}
      ) AS "distanceMeters"
    FROM "City" c
    ORDER BY "distanceMeters" ASC
    LIMIT 1
  `);

  const fallback = nearest[0];
  return fallback ? cityMatchSchema.parse(fallback) : null;
}

// --- coverage ---------------------------------------------------------------

/**
 * The single question every geo entry point asks first: **is this point one we
 * can answer anything about?**
 *
 * Correction 9 exists because that question was never asked. A pin dropped in
 * Mumbai produced zero listings, a refused OSRM route, no POIs, no fuel price
 * and a `cityId` misfiled to a city 1,300 km away — five separate symptoms of
 * one unhandled state, none of which said "we do not serve that city yet".
 *
 * Three answers in one statement, because they are one round trip and the
 * middle one is meaningless without the first:
 *
 *  1. **Is the point inside any PADDED bbox?** That is the coverage frontier:
 *     the padded boxes are what `osmium extract` cut, so outside them there is
 *     no road graph, no geocoder index and no POI database. Note it is
 *     `isInsideAny`-shaped — a union of rectangles, not the bounding rectangle
 *     of the union, which would put most of the Deccan "inside" coverage.
 *  2. **Which boundary covers it?** `ST_Covers` against `City.boundary`,
 *     smallest polygon first. See `resolveCityForPoint` for why `ST_Covers`
 *     rather than `ST_Contains`.
 *  3. **Which city centroid is nearest, and how far?** Two jobs: inside
 *     coverage it is the fallback for a point in a gap between boundaries, and
 *     outside coverage it is the "Bengaluru is nearest, 840 km away" in the
 *     message. The distinction is the whole correction — the same number is a
 *     legitimate assignment on one side of the frontier and silent data
 *     corruption on the other.
 *
 * The padded boxes arrive as a parameter rather than being read from the city
 * config, so this package stays free of it and the function can be tested
 * against arbitrary boxes. Every coordinate in them is a bound parameter.
 */
const coverageRowSchema = z.object({
  inside: z.boolean(),
  boundaryCityId: z.string().nullable(),
  boundaryCitySlug: z.string().nullable(),
  boundaryCityName: z.string().nullable(),
  nearestCityId: z.string().nullable(),
  nearestCitySlug: z.string().nullable(),
  nearestCityName: z.string().nullable(),
  nearestDistanceMeters: z.number().nullable(),
});

export interface CoverageCity {
  id: string;
  slug: string;
  name: string;
}

export interface NearestCoverageCity extends CoverageCity {
  distanceMeters: number;
}

export type CoverageResolution =
  | {
      covered: true;
      city: CoverageCity;
      /**
       * `covers` is containment. `nearest` is the in-coverage fallback for a
       * point in a gap between two boundaries — correct, and labelled so every
       * caller can log it. It never appears with `covered: false`.
       */
      method: 'covers' | 'nearest';
      /** Zero for a containment match; centroid distance for the fallback. */
      distanceMeters: number;
      /** The nearest city by centroid, whatever the assignment was. */
      nearest: NearestCoverageCity | null;
    }
  | {
      covered: false;
      /** For the message. Null only when no city is configured at all. */
      nearest: NearestCoverageCity | null;
    };

/** A bounding box as it reaches SQL. Same shape as `CityBbox`. */
export interface CoverageBbox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export async function resolveCoverage(
  coordinate: Coordinate,
  paddedBboxes: readonly CoverageBbox[],
): Promise<CoverageResolution> {
  if (paddedBboxes.length === 0) {
    // No boxes means nothing was ever cut. Refusing everything is the honest
    // answer — the alternative is claiming coverage of a region with no
    // artifacts behind it, which is the failure D51 makes loud at boot.
    return { covered: false, nearest: null };
  }

  const envelopes = Prisma.join(
    paddedBboxes.map(
      (box) => Prisma.sql`ST_MakeEnvelope(
        ${box.minLng}::double precision,
        ${box.minLat}::double precision,
        ${box.maxLng}::double precision,
        ${box.maxLat}::double precision,
        4326
      )`,
    ),
    ', ',
  );

  const origin = point(coordinate);

  const rows = await prisma.$queryRaw<unknown[]>(Prisma.sql`
    WITH origin AS (SELECT ${origin} AS geog),
    frontier AS (
      -- ST_Collect, not ST_Union: the boxes are disjoint for the seed cities
      -- and a collection answers ST_Intersects identically at a fraction of
      -- the cost. Planar geometry on purpose — a bbox test IS a degree-space
      -- rectangle test, and casting to geography here would buy spheroidal
      -- semantics nobody asked for.
      SELECT ST_Intersects(
        ST_Collect(ARRAY[${envelopes}]),
        (SELECT geog::geometry FROM origin)
      ) AS "inside"
    ),
    boundary_hit AS (
      SELECT c."id", c."slug", c."name"
      FROM "City" c, origin o
      WHERE c."boundary" IS NOT NULL
        AND ST_Covers(c."boundary", o.geog)
      ORDER BY ST_Area(c."boundary"::geometry) ASC
      LIMIT 1
    ),
    nearest AS (
      SELECT
        c."id",
        c."slug",
        c."name",
        ST_Distance(
          ST_SetSRID(
            ST_MakePoint(c."centroidLng"::double precision, c."centroidLat"::double precision),
            4326
          )::geography,
          o.geog
        ) AS "meters"
      FROM "City" c, origin o
      ORDER BY "meters" ASC
      LIMIT 1
    )
    SELECT
      (SELECT "inside" FROM frontier)                       AS "inside",
      (SELECT "id" FROM boundary_hit)                       AS "boundaryCityId",
      (SELECT "slug" FROM boundary_hit)                     AS "boundaryCitySlug",
      (SELECT "name" FROM boundary_hit)                     AS "boundaryCityName",
      (SELECT "id" FROM nearest)                            AS "nearestCityId",
      (SELECT "slug" FROM nearest)                          AS "nearestCitySlug",
      (SELECT "name" FROM nearest)                          AS "nearestCityName",
      (SELECT "meters" FROM nearest)::double precision      AS "nearestDistanceMeters"
  `);

  const row = coverageRowSchema.parse(rows[0]);

  const nearest: NearestCoverageCity | null =
    row.nearestCityId && row.nearestCitySlug && row.nearestCityName
      ? {
          id: row.nearestCityId,
          slug: row.nearestCitySlug,
          name: row.nearestCityName,
          distanceMeters: row.nearestDistanceMeters ?? 0,
        }
      : null;

  if (!row.inside) {
    return { covered: false, nearest };
  }

  if (row.boundaryCityId && row.boundaryCitySlug && row.boundaryCityName) {
    return {
      covered: true,
      city: { id: row.boundaryCityId, slug: row.boundaryCitySlug, name: row.boundaryCityName },
      method: 'covers',
      distanceMeters: 0,
      nearest,
    };
  }

  if (!nearest) {
    // Inside a padded box with no cities in the database at all: the artifacts
    // and the seed disagree, which is a deploy fault rather than a user one.
    return { covered: false, nearest: null };
  }

  // Inside coverage, in a gap between boundaries. THIS is where the centroid
  // fallback is correct, and the only place it is reachable.
  return {
    covered: true,
    city: { id: nearest.id, slug: nearest.slug, name: nearest.name },
    method: 'nearest',
    distanceMeters: nearest.distanceMeters,
    nearest,
  };
}

/**
 * How near two coverage requests have to be to count as asking for the same
 * place, in metres.
 *
 * 50 km, which is roughly "the same metro area and its commuter belt". The
 * number this feeds is "you are the Nth person to ask about somewhere near
 * here", so it wants to be generous: Thane and Colaba are 40 km apart and
 * anyone asking about either is asking for Mumbai.
 */
export const COVERAGE_REQUEST_CLUSTER_METERS = 50_000;

/**
 * Records a request for a city the product does not cover, and returns how many
 * distinct people have now asked for somewhere near that point.
 *
 * The upsert is on `(email, lat, lng)` with the coordinates already rounded by
 * the caller, so one person tapping "tell me" repeatedly increments `asks`
 * rather than adding rows — otherwise the count below counts taps.
 *
 * The count is spatial rather than exact-match, for the reason on
 * `COVERAGE_REQUEST_CLUSTER_METERS`: two people asking for Mumbai will not have
 * dropped their pins on the same building.
 */
export async function recordCoverageRequest(input: {
  email: string;
  lat: number;
  lng: number;
  placeLabel?: string | undefined;
}): Promise<{ asks: number; peopleNearby: number }> {
  const row = await prisma.coverageRequest.upsert({
    where: { email_lat_lng: { email: input.email, lat: input.lat, lng: input.lng } },
    create: {
      email: input.email,
      lat: input.lat,
      lng: input.lng,
      ...(input.placeLabel ? { placeLabel: input.placeLabel } : {}),
    },
    // A later ask may carry a label an earlier one could not resolve, so the
    // label is filled in but never blanked out.
    update: {
      asks: { increment: 1 },
      ...(input.placeLabel ? { placeLabel: input.placeLabel } : {}),
    },
    select: { asks: true },
  });

  const counted = await prisma.$queryRaw<Array<{ people: number }>>(Prisma.sql`
    SELECT count(DISTINCT "email")::int AS "people"
    FROM "CoverageRequest"
    WHERE ST_DWithin(
      "location",
      ${point({ lat: input.lat, lng: input.lng })},
      ${COVERAGE_REQUEST_CLUSTER_METERS}
    )
  `);

  return { asks: row.asks, peopleNearby: Number(counted[0]?.people ?? 1) };
}
