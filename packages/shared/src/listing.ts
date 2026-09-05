import { z } from 'zod';
import {
  enquiryStatusSchema,
  furnishingTypeSchema,
  listingStatusSchema,
  listingTypeSchema,
  propertyTypeSchema,
} from './enums.js';
import {
  OUT_OF_COVERAGE_CODE,
  coordinateSchema,
  outOfCoverageSchema,
  radiusMetersSchema,
  ringSchema,
  transitFareConfigSchema,
} from './geo/index.js';

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

/**
 * `total_cost` is the product's own argument as a sort: rent plus maintenance
 * plus the real monthly commute, ranked ascending.
 *
 * It is not a client-side re-sort of a page. Ranking a page would show the
 * cheapest of 24 arbitrary listings rather than the cheapest of the 200 in the
 * radius — which is precisely the inversion the product exists to surface, and
 * precisely the one a page-local sort hides. See DECISIONS.md D64.
 */
export const listingSortSchema = z
  .enum(['distance', 'price_asc', 'price_desc', 'newest', 'total_cost'])
  .default('distance');

export type ListingSort = z.infer<typeof listingSortSchema>;

/**
 * Everything the SQL needs to price a commute, per request.
 *
 * All scalars, deliberately: the whole point is that the cost becomes an
 * expression inside the search query, so it can be ordered and paged on. The
 * moment one of these had to be looked up per row, the sort would have to move
 * out of SQL and back into the application.
 *
 * Supplied by the API from the caller's stored preferences, the scraped fuel
 * price and the city's fare table — never by the client, which has no business
 * naming the fuel price its own commute is costed with.
 */
export const commuteSqlParamsSchema = z.object({
  mode: z.enum(['car', 'bike', 'transit']),
  /** Rupees per litre, or per kg for CNG. Zero when no price is known. */
  fuelPricePerLitre: z.number().nonnegative(),
  mileageKmPerLitre: z.number().positive(),
  tripsPerDay: z.number().int().positive(),
  workingDaysPerMonth: z.number().int().positive(),
  /** Required for `mode: 'transit'`, ignored otherwise. */
  transitFare: transitFareConfigSchema.optional(),
});

export type CommuteSqlParams = z.infer<typeof commuteSqlParamsSchema>;

/**
 * One listing's measured road distance from the office.
 *
 * `estimated` is what keeps a routing failure from silently deleting a
 * listing. OSRM can return null for a coordinate its graph cannot reach, and
 * dropping those rows would remove homes from the results for a reason the user
 * cannot see — so they carry a straight-line estimate and say so.
 */
export const roadDistanceSchema = z.object({
  listingId: z.string().min(1),
  meters: z.number().nonnegative(),
  estimated: z.boolean(),
});

export type RoadDistance = z.infer<typeof roadDistanceSchema>;

export const listingSearchInputSchema = z.object({
  office: coordinateSchema,
  radiusMeters: radiusMetersSchema,
  filters: listingFiltersSchema.default({}),
  sort: listingSortSchema,
  /**
   * Commute parameters, present whenever the caller wants cost figures — which
   * `sort: 'total_cost'` requires. Absent means the query returns null commute
   * columns and cannot be sorted by total cost.
   */
  commute: commuteSqlParamsSchema.optional(),
  /**
   * Road distances for the candidate set, from one OSRM `/table` request.
   *
   * The whole filtered set, not the page: a keyset sort on total cost has to
   * compare every candidate, and asking for a page's worth would rank 24
   * arbitrary listings.
   */
  roadDistances: z.array(roadDistanceSchema).default([]),
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

  /**
   * Real ROAD metres from the office, when the search measured them.
   *
   * Null when no commute parameters were supplied — the ordinary sorts do not
   * need an OSRM round trip and do not pay for one.
   */
  roadDistanceMeters: z.number().nonnegative().nullable().default(null),
  /** Rupees per month for the selected mode, computed in SQL. */
  commuteMonthly: z.number().nonnegative().nullable().default(null),
  /**
   * Rent + maintenance + commute. Null for a sale listing, where a monthly
   * total would need an interest rate this product never asks for.
   */
  totalMonthlyCost: z.number().nonnegative().nullable().default(null),
  /** True when the road distance is a labelled straight-line estimate. */
  commuteEstimated: z.boolean().default(false),
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

/**
 * What `GET /api/listings/search` actually returns, as a discriminated union.
 *
 * A union rather than an extra field, because the two arms have nothing in
 * common and a shared shape would let a caller read `total: 0` off an
 * out-of-coverage response and render "no listings near you" — which is the
 * exact confusion correction 9 exists to remove. `status` is the discriminant,
 * so TypeScript refuses to read `listings` without checking it first.
 *
 * 200, not an error status: "we do not serve that city yet" is a successful and
 * complete answer to a well-formed question. Listing *creation* out of coverage
 * is a 422, because that one is a refusal.
 */
/**
 * What the search did about commute cost, stated once for the whole response.
 *
 * Null when it could not be costed at all — a city with no scraped fuel price
 * yet. `anyEstimated` and `sortedByTotalCost` are the two honesty flags: the
 * first says at least one distance is a straight-line fallback, the second says
 * whether the sort the client asked for actually happened, because a search
 * that quietly ranked by distance while the UI claims "total cost" would be
 * lying about the product's headline feature.
 */
export const searchCommuteSummarySchema = z.object({
  mode: z.enum(['car', 'bike', 'transit']),
  fuelPricePerLitre: z.number().nonnegative(),
  anyEstimated: z.boolean(),
  sortedByTotalCost: z.boolean(),
});

export type SearchCommuteSummary = z.infer<typeof searchCommuteSummarySchema>;

export const searchResponseSchema = z.discriminatedUnion('status', [
  listingSearchResponseSchema.extend({
    status: z.literal('ok'),
    commute: searchCommuteSummarySchema.nullable().default(null),
  }),
  z.object({
    status: z.literal(OUT_OF_COVERAGE_CODE),
    coverage: outOfCoverageSchema,
  }),
]);

export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const amenitySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  category: z.string(),
});

export type Amenity = z.infer<typeof amenitySchema>;

/**
 * Amenities as the wizard's checklist wants them: grouped by category, because
 * the grouping is the form's structure and two clients grouping the same rows
 * differently would be two different forms.
 */
export const amenityGroupSchema = z.object({
  category: z.string(),
  amenities: z.array(amenitySchema),
});

export type AmenityGroup = z.infer<typeof amenityGroupSchema>;

export const amenityGroupsResponseSchema = z.object({ groups: z.array(amenityGroupSchema) });

// --- the lister dashboard ---------------------------------------------------

/**
 * How long one viewer's view of one listing is deduplicated for.
 *
 * Shared so the chart's caption states the same number the recorder enforces.
 * A caption that drifts from the rule is a chart that lies quietly. See D44.
 */
export const VIEW_DEDUPE_WINDOW_MINUTES = 30;

export const listerAnalyticsSchema = z.object({
  days: z.number().int().positive(),
  /** Stated in the response so the UI cannot describe the number wrongly. */
  viewWindowMinutes: z.number().int().positive(),
  excludesOwner: z.boolean(),
  series: z.array(
    z.object({
      /** YYYY-MM-DD, UTC. */
      date: z.string(),
      views: z.number().int().nonnegative(),
      enquiries: z.number().int().nonnegative(),
    }),
  ),
  totals: z.object({
    views: z.number().int().nonnegative(),
    enquiries: z.number().int().nonnegative(),
    favorites: z.number().int().nonnegative(),
    published: z.number().int().nonnegative(),
    drafts: z.number().int().nonnegative(),
    /**
     * Enquiries per hundred views. Null when there were no views — "0 per 100"
     * would claim a measurement nobody took.
     */
    enquiriesPerHundredViews: z.number().nonnegative().nullable(),
  }),
});

export type ListerAnalytics = z.infer<typeof listerAnalyticsSchema>;

export const ownedListingSchema = z.object({
  id: z.string(),
  slug: z.string(),
  /** Null on a draft that has not reached the step that names it (D67). */
  title: z.string().nullable(),
  status: listingStatusSchema,
  listingType: listingTypeSchema,
  propertyType: propertyTypeSchema.nullable(),
  locality: z.string().nullable(),
  bedrooms: z.number().int().nullable(),
  areaSqft: z.number().int().nullable(),
  rentAmount: z.number().int().nullable(),
  salePrice: z.number().int().nullable(),
  isVerified: z.boolean(),
  viewCount: z.number().int(),
  enquiryCount: z.number().int(),
  favoriteCount: z.number().int(),
  imageCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string().nullable(),
});

export type OwnedListing = z.infer<typeof ownedListingSchema>;

export const ownedListingsResponseSchema = z.object({
  listings: z.array(ownedListingSchema),
  nextCursor: z.string().nullable(),
});

// --- enquiries --------------------------------------------------------------

export const enquiryMessageSchema = z.object({
  id: z.string(),
  senderId: z.string(),
  senderName: z.string(),
  body: z.string(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
  /** True when the signed-in reader wrote it. */
  mine: z.boolean(),
});

export type EnquiryMessage = z.infer<typeof enquiryMessageSchema>;

export const enquiryThreadSchema = z.object({
  id: z.string(),
  status: enquiryStatusSchema,
  createdAt: z.string(),
  lastMessageAt: z.string(),
  /** Messages the reader has not read, written by the other party. */
  unreadCount: z.number().int().nonnegative(),
  /** Which side of the thread the reader is on. */
  role: z.enum(['seeker', 'lister']),
  counterpart: z.object({
    id: z.string(),
    name: z.string(),
    /**
     * Revealed only once an enquiry exists between these two people, which is
     * what "masked until an enquiry is sent" means in practice. Null when the
     * user has not given one.
     */
    phone: z.string().nullable(),
    email: z.string().nullable(),
  }),
  listing: z.object({
    id: z.string(),
    slug: z.string(),
    title: z.string().nullable(),
    locality: z.string().nullable(),
    rentAmount: z.number().int().nullable(),
    salePrice: z.number().int().nullable(),
    listingType: listingTypeSchema,
    coverUrl: z.string().nullable(),
  }),
  /** The most recent message, for the list view. */
  preview: z.string().nullable(),
});

export type EnquiryThread = z.infer<typeof enquiryThreadSchema>;

export const enquiryListResponseSchema = z.object({
  threads: z.array(enquiryThreadSchema),
  /** Total unread across every thread, for the nav badge. */
  unreadTotal: z.number().int().nonnegative(),
});

export const enquiryDetailResponseSchema = z.object({
  thread: enquiryThreadSchema,
  messages: z.array(enquiryMessageSchema),
});

export const enquiryMessageInputSchema = z.object({
  body: z.string().trim().min(2, 'Say a little more').max(4_000),
});

export type EnquiryMessageInput = z.input<typeof enquiryMessageInputSchema>;
