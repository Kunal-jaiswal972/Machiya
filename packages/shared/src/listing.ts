import { z } from 'zod';
import {
  furnishingTypeSchema,
  listingStatusSchema,
  listingTypeSchema,
  propertyTypeSchema,
} from './enums.js';
import { coordinateSchema, radiusMetersSchema, ringSchema } from './geo/index.js';

/**
 * Every filter the map search accepts. All of them compose into ONE
 * parameterised SQL statement in packages/db/src/geo-queries.ts — nothing here
 * is ever applied by filtering a superset in JavaScript.
 */
export const listingFiltersSchema = z.object({
  listingType: listingTypeSchema.optional(),
  propertyType: z.array(propertyTypeSchema).nonempty().optional(),
  furnishing: z.array(furnishingTypeSchema).nonempty().optional(),

  /** Whole rupees. Applies to rentAmount for RENT and salePrice for SALE. */
  priceMin: z.coerce.number().int().nonnegative().optional(),
  priceMax: z.coerce.number().int().nonnegative().optional(),

  bedroomsMin: z.coerce.number().int().min(0).max(20).optional(),
  bedroomsMax: z.coerce.number().int().min(0).max(20).optional(),
  bathroomsMin: z.coerce.number().int().min(0).max(20).optional(),

  areaSqftMin: z.coerce.number().int().positive().optional(),
  areaSqftMax: z.coerce.number().int().positive().optional(),

  /** Available on or before this date. */
  availableBy: z.coerce.date().optional(),

  /** Restrict to one distance ring without refetching a different radius. */
  ring: ringSchema.optional(),

  /** Amenity slugs; a listing must have ALL of them to match. */
  amenitySlugs: z.array(z.string().min(1)).nonempty().optional(),

  citySlug: z.string().min(1).optional(),

  /** Fuzzy match against title and address, backed by the pg_trgm indexes. */
  query: z.string().min(2).max(120).optional(),

  verifiedOnly: z.coerce.boolean().optional(),
});

export type ListingFilters = z.infer<typeof listingFiltersSchema>;

export const listingSortSchema = z
  .enum(['distance', 'price_asc', 'price_desc', 'newest'])
  .default('distance');

export type ListingSort = z.infer<typeof listingSortSchema>;

export const listingSearchInputSchema = z.object({
  office: coordinateSchema,
  radiusMeters: radiusMetersSchema,
  filters: listingFiltersSchema.default({}),
  sort: listingSortSchema,
  limit: z.coerce.number().int().min(1).max(100).default(24),
  /** Opaque keyset cursor from the previous page. */
  cursor: z.string().min(1).optional(),
  /**
   * Which statuses to include. Defaults to PUBLISHED only; the lister dashboard
   * and admin queue pass their own set, and the API decides that — never the
   * client.
   */
  statuses: z.array(listingStatusSchema).nonempty().default(['PUBLISHED']),
});

export type ListingSearchInput = z.input<typeof listingSearchInputSchema>;
export type ListingSearchOptions = z.infer<typeof listingSearchInputSchema>;

/**
 * The columns the map layer and the result cards need — deliberately not a full
 * Listing row. Nothing here is heavy enough to hurt at 60 markers.
 */
export const listingSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  listingType: listingTypeSchema,
  propertyType: propertyTypeSchema,
  status: listingStatusSchema,
  furnishing: furnishingTypeSchema,
  locality: z.string(),
  lat: z.number(),
  lng: z.number(),
  bedrooms: z.number().int(),
  bathrooms: z.number().int(),
  areaSqft: z.number().int(),
  rentAmount: z.number().int().nullable(),
  salePrice: z.number().int().nullable(),
  maintenanceMonthly: z.number().int().nullable(),
  isVerified: z.boolean(),

  /**
   * The cover photo's variant prefix — NOT the original's object key, which is
   * nulled once the worker has derived the variants and would therefore be null
   * for every processed image. Only READY images are considered, so a listing
   * whose photos are still being decoded has no cover rather than a broken one.
   *
   * Turning this into a URL is the API's job, not the database's: the public
   * base URL is deployment configuration and `packages/db` has no business
   * knowing it. See `listingCardSchema` below.
   */
  coverVariantBase: z.string().nullable(),
  /** Inline base64 preview, so a card never flashes empty. */
  coverLqip: z.string().nullable(),
  /** Average colour of the cover, for the block behind a loading photo. */
  coverDominantColor: z.string().nullable(),

  /** Straight-line metres from the office. Road distance comes from OSRM. */
  distanceMeters: z.number().nonnegative(),
  ring: ringSchema,
});

export type ListingSummary = z.infer<typeof listingSummarySchema>;

/**
 * What the API actually sends for a result card: the same row with the cover
 * resolved to a fetchable URL.
 */
export const listingCardSchema = listingSummarySchema
  .omit({ coverVariantBase: true })
  .extend({ coverUrl: z.string().nullable() });

export const listingCardListSchema = z.object({ listings: z.array(listingCardSchema) });

export type ListingCard = z.infer<typeof listingCardSchema>;

export const listingSearchResultSchema = z.object({
  listings: z.array(listingSummarySchema),
  nextCursor: z.string().nullable(),
  /** Per-ring counts for the whole result set, not just this page. */
  ringCounts: z.object({ 1: z.number().int(), 2: z.number().int(), 3: z.number().int() }),
  total: z.number().int().nonnegative(),
});

export type ListingSearchResult = z.infer<typeof listingSearchResultSchema>;

/** The search response as it leaves the API. */
export const listingSearchResponseSchema = listingSearchResultSchema
  .omit({ listings: true })
  .extend({ listings: z.array(listingCardSchema) });

export type ListingSearchResponse = z.infer<typeof listingSearchResponseSchema>;
