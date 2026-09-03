import { z } from 'zod';
import { furnishingTypeSchema, listingTypeSchema, propertyTypeSchema } from './enums.js';
import { latitudeSchema, longitudeSchema, radiusMetersSchema, ringSchema } from './geo/index.js';
import { listingSortSchema, type ListingFilters } from './listing.js';

/**
 * The URL **is** the search state.
 *
 * Office, radius, every filter and the sort all live in the query string, which
 * is what makes a search shareable and back/forward correct. That only works if
 * the client and the server agree exactly on the encoding — so both sides use
 * the two functions in this file, and neither builds a query string by hand.
 *
 * Two encoding rules:
 *  - multi-value filters are comma-separated, not repeated keys. `?type=A,B` is
 *    readable in a shared link; `?type=A&type=B` is not, and the two halves can
 *    be separated by a careless copy-paste.
 *  - a filter at its default is ABSENT, never spelled out. A URL that carries
 *    every default is unreadable, and a shared link should show what was chosen.
 */

/**
 * A comma-separated list of one enum's values.
 *
 * Written as an explicit `superRefine`-free transform rather than
 * `.pipe(z.array(item))` because zod 4's `pipe` requires the downstream input
 * type to be `string[]`, which a `ZodArray<T>` is not.
 */
const csvArray = <T extends z.ZodType<string>>(item: T) =>
  z
    .string()
    .transform((value, ctx) => {
      const parts = value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

      if (parts.length === 0) {
        ctx.addIssue({ code: 'custom', message: 'Expected at least one value' });
        return z.NEVER;
      }

      const parsed: Array<z.infer<T>> = [];

      for (const part of parts) {
        const result = item.safeParse(part);
        if (!result.success) {
          ctx.addIssue({ code: 'custom', message: `Unknown value: ${part}` });
          return z.NEVER;
        }
        parsed.push(result.data);
      }

      return parsed as [z.infer<T>, ...Array<z.infer<T>>];
    })
    .optional();

const boolish = z
  .string()
  .transform((value) => value === 'true' || value === '1')
  .optional();

export const searchQuerySchema = z.object({
  // --- the office, and how far from it -------------------------------------
  // Coerced, because these arrive as query-string text on the server and as
  // text from `URLSearchParams` in the browser. The range check still applies.
  lat: z.coerce.number().pipe(latitudeSchema).optional(),
  lng: z.coerce.number().pipe(longitudeSchema).optional(),
  radius: radiusMetersSchema.optional(),

  // --- filters -------------------------------------------------------------
  city: z.string().min(1).optional(),
  type: listingTypeSchema.optional(),
  property: csvArray(propertyTypeSchema),
  furnishing: csvArray(furnishingTypeSchema),
  amenities: csvArray(z.string().min(1)),
  priceMin: z.coerce.number().int().nonnegative().optional(),
  priceMax: z.coerce.number().int().nonnegative().optional(),
  bedsMin: z.coerce.number().int().min(0).max(20).optional(),
  bedsMax: z.coerce.number().int().min(0).max(20).optional(),
  bathsMin: z.coerce.number().int().min(0).max(20).optional(),
  areaMin: z.coerce.number().int().positive().optional(),
  areaMax: z.coerce.number().int().positive().optional(),
  availableBy: z.string().min(1).optional(),
  ring: z.coerce.number().pipe(ringSchema).optional(),
  verified: boolish,
  q: z.string().trim().min(2).max(120).optional(),

  // --- presentation --------------------------------------------------------
  sort: listingSortSchema.optional(),
  cursor: z.string().min(1).optional(),
  /** Page size. The map wants the whole radius; the list pages. */
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;

/** The client's view of search state: coordinates plus everything above. */
export interface SearchState {
  office: { lat: number; lng: number } | null;
  radiusMeters: number;
  filters: ListingFilters;
  sort: z.infer<typeof listingSortSchema>;
  citySlug?: string;
}

export function parseSearchQuery(input: Record<string, string | undefined>): SearchQuery {
  // Empty strings are dropped rather than validated: a cleared input leaves
  // `?priceMax=` behind, and that means "no maximum", not "invalid".
  const cleaned = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== ''),
  );

  return searchQuerySchema.parse(cleaned);
}

/**
 * Query string to the shape `searchListingsInRadius` takes.
 *
 * Returns null when there is no office yet — the whole search is anchored to a
 * point, so without one there is nothing to run.
 */
export function searchQueryToInput(query: SearchQuery) {
  if (query.lat === undefined || query.lng === undefined) return null;

  const filters: ListingFilters = {
    ...(query.city ? { citySlug: query.city } : {}),
    ...(query.type ? { listingType: query.type } : {}),
    ...(query.property ? { propertyType: query.property } : {}),
    ...(query.furnishing ? { furnishing: query.furnishing } : {}),
    ...(query.amenities ? { amenitySlugs: query.amenities } : {}),
    ...(query.priceMin !== undefined ? { priceMin: query.priceMin } : {}),
    ...(query.priceMax !== undefined ? { priceMax: query.priceMax } : {}),
    ...(query.bedsMin !== undefined ? { bedroomsMin: query.bedsMin } : {}),
    ...(query.bedsMax !== undefined ? { bedroomsMax: query.bedsMax } : {}),
    ...(query.bathsMin !== undefined ? { bathroomsMin: query.bathsMin } : {}),
    ...(query.areaMin !== undefined ? { areaSqftMin: query.areaMin } : {}),
    ...(query.areaMax !== undefined ? { areaSqftMax: query.areaMax } : {}),
    ...(query.availableBy ? { availableBy: new Date(query.availableBy) } : {}),
    ...(query.ring ? { ring: query.ring } : {}),
    ...(query.verified ? { verifiedOnly: true } : {}),
    ...(query.q ? { query: query.q } : {}),
  };

  return {
    office: { lat: query.lat, lng: query.lng },
    radiusMeters: query.radius ?? 3000,
    sort: query.sort ?? 'distance',
    filters,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
  };
}

/**
 * Search state back to a query string, dropping anything at its default.
 *
 * The inverse of `parseSearchQuery`, and a test round-trips the two — a URL that
 * does not survive a parse-and-rebuild silently loses a filter when the user
 * changes something else.
 */
export function buildSearchParams(query: SearchQuery): URLSearchParams {
  const params = new URLSearchParams();

  const put = (key: string, value: string | number | undefined | null): void => {
    if (value === undefined || value === null || value === '') return;
    params.set(key, String(value));
  };

  put('lat', query.lat === undefined ? undefined : query.lat.toFixed(6));
  put('lng', query.lng === undefined ? undefined : query.lng.toFixed(6));
  // 3000 is the default radius, so it stays out of the URL.
  put('radius', query.radius === 3000 ? undefined : query.radius);
  put('city', query.city);
  put('type', query.type);
  if (query.property) params.set('property', query.property.join(','));
  if (query.furnishing) params.set('furnishing', query.furnishing.join(','));
  if (query.amenities) params.set('amenities', query.amenities.join(','));
  put('priceMin', query.priceMin);
  put('priceMax', query.priceMax);
  put('bedsMin', query.bedsMin);
  put('bedsMax', query.bedsMax);
  put('bathsMin', query.bathsMin);
  put('areaMin', query.areaMin);
  put('areaMax', query.areaMax);
  put('availableBy', query.availableBy);
  put('ring', query.ring);
  if (query.verified) params.set('verified', 'true');
  put('q', query.q);
  // 'distance' is the default sort.
  put('sort', query.sort === 'distance' ? undefined : query.sort);
  put('cursor', query.cursor);
  // Deliberately NOT in the URL: page size is a client concern, and a shared
  // link carrying `limit=100` would be a shared link that loads differently.

  return params;
}

/** How many filters are active, for the "3 filters" badge on the chip row. */
export function countActiveFilters(query: SearchQuery): number {
  const keys: Array<keyof SearchQuery> = [
    'type',
    'property',
    'furnishing',
    'amenities',
    'priceMin',
    'priceMax',
    'bedsMin',
    'bedsMax',
    'bathsMin',
    'areaMin',
    'areaMax',
    'availableBy',
    'ring',
    'verified',
    'q',
  ];

  return keys.filter((key) => {
    const value = query[key];
    if (value === undefined) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'boolean') return value;
    return true;
  }).length;
}
