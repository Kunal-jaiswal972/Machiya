import { createHash } from 'node:crypto';
import { findSimilarListings, prisma, straightLineDistanceMeters } from '@machiya/db';
import {
  POI_RADIUS_METERS,
  routeProfileSchema,
  type Coordinate,
  type ListingCard,
  type PoiLookupResult,
  type RouteProfile,
  type RouteResult,
} from '@machiya/shared';
import { variantObjectKey } from '@machiya/shared/images';
import { estimateRoute, resolveRoutingProvider } from '../geo/osrm.js';
import { resolvePoiProvider } from '../geo/overpass.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { publicVariantUrl } from '../lib/storage.js';
import { logger } from '../logger.js';
import { HttpError } from '../middleware/error-handler.js';

/**
 * Everything the detail view needs beyond the listing row itself: the commute
 * route, the nearby places, similar listings, and the view count.
 *
 * Each is a separate request on purpose. They have different failure modes and
 * different TTLs, and none of them may block the listing from rendering — a
 * page that waits for Overpass before showing a rent is a page that is
 * sometimes 25 seconds slow.
 */

async function requireListingPoint(slug: string): Promise<{ id: string; point: Coordinate }> {
  const listing = await prisma.listing.findUnique({
    where: { slug },
    select: { id: true, lat: true, lng: true, status: true },
  });

  // Only published listings have a public commute or POI panel: a draft's
  // coordinates are the owner's business.
  if (!listing || listing.status !== 'PUBLISHED') {
    throw new HttpError(404, 'listing_not_found', 'No such listing');
  }

  return { id: listing.id, point: { lat: listing.lat, lng: listing.lng } };
}

/**
 * Road route from an office to a listing.
 *
 * Falls back to a straight-line estimate marked `degraded` when OSRM cannot
 * answer — the graph may not be built, or the container may be down, and
 * neither should leave the commute panel blank. The estimate is labelled in the
 * UI rather than passed off as measured.
 */
export async function getListingRoute(input: {
  slug: string;
  from: Coordinate;
  profile: RouteProfile;
  signal?: AbortSignal;
}): Promise<RouteResult> {
  const profile = routeProfileSchema.parse(input.profile);
  const { point } = await requireListingPoint(input.slug);

  const route = await resolveRoutingProvider().route({
    from: input.from,
    to: point,
    profile,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  if (route) return route;

  const straightLine = await straightLineDistanceMeters(input.from, point);
  return estimateRoute({ straightLineMeters: straightLine, profile });
}

/** Nearby places for one listing. Cached and degrading inside the provider. */
export async function getListingPois(input: {
  slug: string;
  signal?: AbortSignal;
}): Promise<PoiLookupResult> {
  const { point } = await requireListingPoint(input.slug);

  return resolvePoiProvider().nearby({
    center: point,
    radiusMeters: POI_RADIUS_METERS,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

/** Similar listings, bounded by distance as well as price (D18). */
export async function getSimilarListings(slug: string): Promise<ListingCard[]> {
  const listing = await prisma.listing.findUnique({
    where: { slug },
    select: { id: true, status: true },
  });

  if (!listing || listing.status !== 'PUBLISHED') {
    throw new HttpError(404, 'listing_not_found', 'No such listing');
  }

  const similar = await findSimilarListings({ listingId: listing.id, limit: 6 });

  return similar.map(({ coverVariantBase, ...rest }) => ({
    ...rest,
    // A similar-listings strip is a search result in miniature, so it carries
    // the same ring the search would give it — relative to the SUBJECT, which
    // is what "nearby" means here.
    ring: 1 as const,
    coverUrl: coverVariantBase
      ? publicVariantUrl(variantObjectKey(coverVariantBase, 'card', 'webp'))
      : null,
  }));
}

/**
 * Records a view, at most once per viewer per listing per window.
 *
 * Without deduplication the count measures refreshes, not interest: a lister
 * watching their own page, a bot, or someone flipping between two listings
 * would each inflate it. The dedupe key is the signed-in user id when there is
 * one and a **hashed** IP + user-agent otherwise — hashed because a raw IP in
 * Redis is personal data the product has no use for, and a one-way digest keys
 * a counter just as well.
 *
 * Both a `ListingView` row and the denormalised `viewCount` are written: the
 * rows are what the analytics chart aggregates, the counter is what the search
 * query reads. They are updated together so they cannot disagree.
 */
const VIEW_DEDUPE_WINDOW_SECONDS = 30 * 60;

export async function recordListingView(input: {
  slug: string;
  userId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}): Promise<{ counted: boolean }> {
  const listing = await prisma.listing.findUnique({
    where: { slug: input.slug },
    select: { id: true, status: true, ownerId: true },
  });

  if (!listing || listing.status !== 'PUBLISHED') {
    // Silent rather than a 404: a view is telemetry, and the page has already
    // decided what to render.
    return { counted: false };
  }

  // An owner reading their own listing is not a view. This is the single
  // biggest source of nonsense in a small site's numbers.
  if (input.userId && input.userId === listing.ownerId) {
    return { counted: false };
  }

  const viewer =
    input.userId ??
    createHash('sha256')
      .update(`${input.ip ?? 'unknown'}|${input.userAgent ?? 'unknown'}`)
      .digest('hex')
      .slice(0, 32);

  const key = `view:${listing.id}:${viewer}`;
  const seen = await cacheGet<number>(key);

  if (seen) return { counted: false };

  await cacheSet(key, 1, VIEW_DEDUPE_WINDOW_SECONDS);

  try {
    await prisma.$transaction([
      prisma.listingView.create({
        data: {
          listingId: listing.id,
          ...(input.userId ? { userId: input.userId } : {}),
        },
      }),
      prisma.listing.update({
        where: { id: listing.id },
        data: { viewCount: { increment: 1 } },
      }),
    ]);
  } catch (error) {
    // Telemetry must never fail a page render.
    logger.warn({ err: error, listingId: listing.id }, 'view count write failed');
    return { counted: false };
  }

  return { counted: true };
}
