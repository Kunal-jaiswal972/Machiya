import { prisma, type Prisma } from '@machiya/db';
import {
  listingFiltersSchema,
  savedSearchInputSchema,
  type CoveredCity,
  type FavoriteListing,
  type SavedSearchView,
} from '@machiya/shared';
import { variantObjectKey } from '@machiya/shared/images';
import { publicVariantUrl } from '../lib/storage.js';
import { HttpError } from '../middleware/error-handler.js';
import type { RequestSession } from '../middleware/require-auth.js';
import { checkCoverage, coverageSet } from './coverage.js';

/**
 * The seeker's own shelves: what they saved and what they search for.
 */

const FAVORITE_LISTING_SELECT = {
  id: true,
  slug: true,
  title: true,
  locality: true,
  listingType: true,
  status: true,
  rentAmount: true,
  salePrice: true,
  maintenanceMonthly: true,
  bedrooms: true,
  areaSqft: true,
  lat: true,
  lng: true,
  city: { select: { slug: true, name: true } },
  images: {
    where: { status: 'READY' },
    orderBy: [{ isCover: 'desc' }, { sortOrder: 'asc' }],
    take: 1,
    select: { variantBaseKey: true },
  },
} satisfies Prisma.ListingSelect;

export async function listFavorites(session: RequestSession): Promise<FavoriteListing[]> {
  const rows = await prisma.favorite.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: 'desc' },
    include: { listing: { select: FAVORITE_LISTING_SELECT } },
    take: 200,
  });

  return rows.map((row) => {
    const base = row.listing.images[0]?.variantBaseKey;

    return {
      favoritedAt: row.createdAt.toISOString(),
      id: row.listing.id,
      slug: row.listing.slug,
      title: row.listing.title,
      locality: row.listing.locality,
      listingType: row.listing.listingType,
      // Kept rather than hidden once a listing leaves the map: somebody who
      // saved twelve flats and finds nine has lost information, not noise. The
      // status travels so the card can say "no longer listed" instead of
      // pretending it is still available.
      status: row.listing.status,
      rentAmount: row.listing.rentAmount,
      salePrice: row.listing.salePrice,
      maintenanceMonthly: row.listing.maintenanceMonthly,
      bedrooms: row.listing.bedrooms,
      areaSqft: row.listing.areaSqft,
      lat: row.listing.lat,
      lng: row.listing.lng,
      citySlug: row.listing.city.slug,
      cityName: row.listing.city.name,
      coverUrl: base ? publicVariantUrl(variantObjectKey(base, 'card', 'webp')) : null,
    };
  });
}

export async function addFavorite(
  session: RequestSession,
  listingId: string,
): Promise<{ listingId: string; favorited: true }> {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: { id: true, status: true },
  });

  if (!listing || listing.status !== 'PUBLISHED') {
    throw new HttpError(404, 'listing_not_found', 'No such listing');
  }

  // Idempotent: a double-tap on an optimistic toggle must not 409.
  await prisma.favorite.upsert({
    where: { userId_listingId: { userId: session.userId, listingId } },
    create: { userId: session.userId, listingId },
    update: {},
  });

  return { listingId, favorited: true };
}

export async function removeFavorite(
  session: RequestSession,
  listingId: string,
): Promise<{ listingId: string; favorited: false }> {
  await prisma.favorite.deleteMany({ where: { userId: session.userId, listingId } });
  return { listingId, favorited: false };
}

/** Just the ids, for the heart on every card without a row per card. */
export async function favoriteIds(session: RequestSession): Promise<string[]> {
  const rows = await prisma.favorite.findMany({
    where: { userId: session.userId },
    select: { listingId: true },
  });
  return rows.map((row) => row.listingId);
}

// --- saved searches ---------------------------------------------------------

/**
 * A saved search holds COORDINATES, so it can outlive the coverage it was saved
 * under.
 *
 * Re-running one whose office now falls outside the served area would hit the
 * out-of-coverage path and read as "this search found nothing" — the precise
 * confusion correction 9 exists to remove. So every saved search is checked on
 * read and carries a `coverage` verdict, and the card offers the nearest served
 * city rather than a re-run that cannot work.
 *
 * Checked on READ rather than stored on the row: coverage is a property of the
 * current artifacts, not of the search, and a stored flag would be wrong the
 * moment a fourth city is added.
 */
export async function listSavedSearches(session: RequestSession): Promise<SavedSearchView[]> {
  const rows = await prisma.savedSearch.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return Promise.all(
    rows.map(async (row): Promise<SavedSearchView> => {
      const resolution = await checkCoverage({ lat: row.officeLat, lng: row.officeLng });

      return {
        id: row.id,
        name: row.name,
        // Re-parsed rather than cast: the column is JSON, and a blob written by
        // an older filter shape must fail here rather than produce a search
        // nobody asked for. An unparseable one degrades to no filters.
        filters: listingFiltersSchema.safeParse(row.filters).data ?? {},
        officeLat: row.officeLat,
        officeLng: row.officeLng,
        radiusMeters: row.radiusMeters,
        notifyEnabled: row.notifyEnabled,
        createdAt: row.createdAt.toISOString(),
        covered: resolution.covered,
        nearestCity: resolution.covered
          ? { slug: resolution.city.slug, name: resolution.city.name }
          : nearestServedCity(resolution.nearest),
      };
    }),
  );
}

function nearestServedCity(
  nearest: { slug: string; name: string } | null,
): { slug: string; name: string } | null {
  if (nearest) return { slug: nearest.slug, name: nearest.name };
  const first: CoveredCity | undefined = coverageSet().cities[0];
  return first ? { slug: first.slug, name: first.name } : null;
}

export async function createSavedSearch(
  session: RequestSession,
  body: unknown,
): Promise<{ id: string }> {
  const input = savedSearchInputSchema.parse(body);

  const existing = await prisma.savedSearch.count({ where: { userId: session.userId } });
  if (existing >= 50) {
    throw new HttpError(409, 'too_many_saved_searches', 'You can keep at most 50 saved searches');
  }

  const saved = await prisma.savedSearch.create({
    data: {
      userId: session.userId,
      name: input.name,
      filters: input.filters,
      officeLat: input.officeLat,
      officeLng: input.officeLng,
      radiusMeters: input.radiusMeters,
      notifyEnabled: input.notifyEnabled,
    },
    select: { id: true },
  });

  return saved;
}

export async function updateSavedSearch(
  session: RequestSession,
  id: string,
  body: unknown,
): Promise<{ id: string }> {
  const input = savedSearchInputSchema.partial().parse(body);

  const owned = await prisma.savedSearch.findUnique({ where: { id }, select: { userId: true } });

  if (!owned || owned.userId !== session.userId) {
    throw new HttpError(404, 'saved_search_not_found', 'No such saved search');
  }

  await prisma.savedSearch.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.filters !== undefined ? { filters: input.filters } : {}),
      ...(input.officeLat !== undefined ? { officeLat: input.officeLat } : {}),
      ...(input.officeLng !== undefined ? { officeLng: input.officeLng } : {}),
      ...(input.radiusMeters !== undefined ? { radiusMeters: input.radiusMeters } : {}),
      ...(input.notifyEnabled !== undefined ? { notifyEnabled: input.notifyEnabled } : {}),
    },
  });

  return { id };
}

export async function deleteSavedSearch(
  session: RequestSession,
  id: string,
): Promise<{ id: string }> {
  const result = await prisma.savedSearch.deleteMany({ where: { id, userId: session.userId } });

  if (result.count === 0) {
    throw new HttpError(404, 'saved_search_not_found', 'No such saved search');
  }

  return { id };
}
