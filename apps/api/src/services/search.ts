import { prisma, searchListingsInRadius } from '@machiya/db';
import {
  OUT_OF_COVERAGE_CODE,
  listingSearchInputSchema,
  type ListingCard,
  type ListingSearchInput,
  type ListingSummary,
  type SearchResponse,
} from '@machiya/shared';
import { variantObjectKey } from '@machiya/shared/images';
import { publicVariantUrl } from '../lib/storage.js';
import { checkCoverage, outOfCoverageFor } from './coverage.js';

/**
 * Radius search, as the API sends it.
 *
 * The query itself lives in `packages/db/src/geo-queries.ts` — one parameterised
 * statement, every filter composed into the same `WHERE`. This module does two
 * things the database has no business doing: it forces the status set, and it
 * turns a stored variant prefix into a fetchable URL.
 */

/** `card` is the 4:3 band on a result card and the marker popover. */
function toCard(listing: ListingSummary): ListingCard {
  const { coverVariantBase, ...rest } = listing;

  return {
    ...rest,
    coverUrl: coverVariantBase
      ? publicVariantUrl(variantObjectKey(coverVariantBase, 'card', 'webp'))
      : null,
  };
}

export async function searchListings(input: ListingSearchInput): Promise<SearchResponse> {
  // `statuses` is never read from the client. A search is a public surface, so
  // PUBLISHED is the only set it can produce — the lister dashboard and the
  // admin queue have their own endpoints with their own guards.
  const options = listingSearchInputSchema.parse({ ...input, statuses: ['PUBLISHED'] });

  // Coverage BEFORE the query, not after an empty result. A radius search
  // around a Mumbai office returns zero rows and no error, which reads as "this
  // product has no listings" rather than "this product does not reach Mumbai
  // yet" — the exact confusion correction 9 removes. See DECISIONS.md D53.
  const coverage = await checkCoverage(options.office);

  if (!coverage.covered) {
    return {
      status: OUT_OF_COVERAGE_CODE,
      coverage: outOfCoverageFor({ coordinate: options.office, nearest: coverage.nearest }),
    };
  }

  const result = await searchListingsInRadius(options);

  return { status: 'ok', ...result, listings: result.listings.map(toCard) };
}

/**
 * The cities the product covers, with their bounds and transit fares.
 *
 * Public and effectively static — three rows that change when someone edits
 * `scripts/cities.ts` and re-seeds. The route caches it hard for that reason.
 */
export async function listCities() {
  const cities = await prisma.city.findMany({
    orderBy: { name: 'asc' },
    select: {
      slug: true,
      name: true,
      state: true,
      centroidLat: true,
      centroidLng: true,
      bbox: true,
      defaultFuelType: true,
      transitFareConfig: true,
      _count: { select: { listings: true } },
    },
  });

  return cities.map(({ _count, ...city }) => ({ ...city, listingCount: _count.listings }));
}
