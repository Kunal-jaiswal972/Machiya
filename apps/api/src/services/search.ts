import { prisma, searchListingsInRadius } from '@machiya/db';
import {
  DEFAULT_COMMUTE_PREFERENCES,
  OUT_OF_COVERAGE_CODE,
  effectiveMileage,
  listingSearchInputSchema,
  routeProfileForMode,
  type CommuteSqlParams,
  type ListingCard,
  type ListingSearchInput,
  type ListingSummary,
  type RoadDistance,
  type SearchResponse,
} from '@machiya/shared';
import { cityBySlug } from '@machiya/shared/cities';
import { variantObjectKey } from '@machiya/shared/images';
import { publicVariantUrl } from '../lib/storage.js';
import type { RequestSession } from '../middleware/require-auth.js';
import { getCommutePreferences } from './commute.js';
import { checkCoverage, outOfCoverageFor } from './coverage.js';
import { getFuelPrice } from './fuel.js';
import { roadDistancesForSearch } from './road-distances.js';

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

/**
 * The commute parameters for this request, or null when they cannot be formed.
 *
 * Null is a real outcome rather than a failure: a city with no scraped fuel
 * price yet cannot have its commute costed, and inventing a price to fill the
 * column would put the least defensible number in the product on every card.
 * The caller then serves the search without commute figures.
 */
async function commuteParamsFor(input: {
  citySlug: string;
  session?: RequestSession | undefined;
}): Promise<CommuteSqlParams | null> {
  const preferences = input.session
    ? await getCommutePreferences(input.session.userId)
    : DEFAULT_COMMUTE_PREFERENCES;

  const reading = await getFuelPrice(input.citySlug, preferences.fuelType);

  // Transit is priced from the city's fare table and needs no fuel price, so it
  // is the one mode that still works without a scrape.
  if (!reading && preferences.mode !== 'transit') return null;

  const city = cityBySlug(input.citySlug);

  return {
    mode: preferences.mode,
    fuelPricePerLitre: reading?.price ?? 0,
    mileageKmPerLitre: effectiveMileage(preferences),
    tripsPerDay: preferences.tripsPerDay,
    workingDaysPerMonth: preferences.workingDaysPerMonth,
    ...(preferences.mode === 'transit' ? { transitFare: city.transitFare } : {}),
  };
}

export async function searchListings(
  input: ListingSearchInput,
  context: { session?: RequestSession | undefined; signal?: AbortSignal } = {},
): Promise<SearchResponse> {
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

  /**
   * Commute figures are computed whenever they can be, not only when sorting
   * by them.
   *
   * Total monthly cost is the product's argument, so it belongs on every card
   * rather than appearing when a control is toggled — and the reorder animation
   * only means anything if the number was already on screen. It costs one
   * cached OSRM `/table` request per office and candidate set.
   */
  const commute = await commuteParamsFor({
    citySlug: coverage.city.slug,
    ...(context.session ? { session: context.session } : {}),
  });

  let roadDistances: RoadDistance[] = [];
  let anyEstimated = false;

  if (commute) {
    const measured = await roadDistancesForSearch({
      options,
      profile: routeProfileForMode(commute.mode),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    roadDistances = measured.distances;
    anyEstimated = measured.anyEstimated;
  }

  // Asking for the total-cost sort without the inputs to compute it would throw
  // in the query builder — deliberately, since silently sorting by something
  // else while the UI says "total cost" is the worse failure. Downgrade here,
  // with the response saying so, rather than 500ing.
  const sortable = commute !== null && roadDistances.length > 0;
  const sort = options.sort === 'total_cost' && !sortable ? 'distance' : options.sort;

  const result = await searchListingsInRadius({
    ...options,
    sort,
    ...(commute ? { commute } : {}),
    roadDistances,
  });

  return {
    status: 'ok',
    ...result,
    listings: result.listings.map(toCard),
    commute: commute
      ? {
          mode: commute.mode,
          fuelPricePerLitre: commute.fuelPricePerLitre,
          anyEstimated,
          sortedByTotalCost: sort === 'total_cost',
        }
      : null,
  };
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
