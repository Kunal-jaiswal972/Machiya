import { randomBytes } from 'node:crypto';
import { prisma } from '@machiya/db';
import {
  listingDraftSchema,
  listingPatchSchema,
  publishableListingSchema,
  type ListingDraft,
  type ListingStatusAction,
} from '@machiya/shared';
import { logger } from '../logger.js';
import { HttpError } from '../middleware/error-handler.js';
import { deleteObjects } from '../lib/storage.js';
import { assertOwnership, type RequestSession } from '../middleware/require-auth.js';
import { listingObjectKeys, toImageView } from './listing-images.js';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Slugs are user-visible, so they carry the city and title — but they must also
 * be unique across every listing ever created, including two identical titles in
 * the same locality. A short random suffix buys that without a retry loop.
 */
function buildSlug(citySlug: string, title: string): string {
  const suffix = randomBytes(4)
    .toString('base64url')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return `${citySlug}-${slugify(title)}-${suffix.slice(0, 6)}`;
}

async function resolveCityId(citySlug: string): Promise<string> {
  const city = await prisma.city.findUnique({ where: { slug: citySlug }, select: { id: true } });

  if (!city) {
    throw new HttpError(400, 'unknown_city', `No city with the slug "${citySlug}"`);
  }

  return city.id;
}

async function resolveAmenityIds(slugs: string[]): Promise<string[]> {
  if (slugs.length === 0) return [];

  const amenities = await prisma.amenity.findMany({
    where: { slug: { in: slugs } },
    select: { id: true, slug: true },
  });

  const found = new Set(amenities.map((amenity) => amenity.slug));
  const missing = slugs.filter((slug) => !found.has(slug));

  if (missing.length > 0) {
    throw new HttpError(400, 'unknown_amenity', `Unknown amenities: ${missing.join(', ')}`);
  }

  return amenities.map((amenity) => amenity.id);
}

/**
 * Loads a listing for a mutation and proves the caller may change it.
 *
 * Every write path goes through here. The owner id comes from the stored row,
 * never from the request — an ownerId in a body is a claim, not an authority.
 */
async function loadForMutation(session: RequestSession, listingId: string) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: { id: true, ownerId: true, status: true, slug: true, listingType: true },
  });

  if (!listing) {
    throw new HttpError(404, 'listing_not_found', 'No such listing');
  }

  assertOwnership(session, listing.ownerId);
  return listing;
}

/**
 * Create needs every required column present, so it cannot reuse the partial
 * spread below — TypeScript is right to reject that, and a runtime failure on a
 * missing NOT NULL column would be a worse way to find out.
 */
function toCreateData(input: ListingDraft) {
  return {
    title: input.title,
    description: input.description,
    listingType: input.listingType,
    propertyType: input.propertyType,
    furnishing: input.furnishing,
    address: input.address,
    locality: input.locality,
    lat: input.lat,
    lng: input.lng,
    bedrooms: input.bedrooms,
    bathrooms: input.bathrooms,
    floor: input.floor ?? null,
    totalFloors: input.totalFloors ?? null,
    areaSqft: input.areaSqft,
    rentAmount: input.rentAmount ?? null,
    salePrice: input.salePrice ?? null,
    securityDeposit: input.securityDeposit ?? null,
    maintenanceMonthly: input.maintenanceMonthly ?? null,
    availableFrom: input.availableFrom ?? null,
    rules: input.rules,
  };
}

/** Patch variant: only the keys actually sent reach the UPDATE. */
function toColumnData(input: Partial<ListingDraft>) {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.listingType !== undefined ? { listingType: input.listingType } : {}),
    ...(input.propertyType !== undefined ? { propertyType: input.propertyType } : {}),
    ...(input.furnishing !== undefined ? { furnishing: input.furnishing } : {}),
    ...(input.address !== undefined ? { address: input.address } : {}),
    ...(input.locality !== undefined ? { locality: input.locality } : {}),
    ...(input.lat !== undefined ? { lat: input.lat } : {}),
    ...(input.lng !== undefined ? { lng: input.lng } : {}),
    ...(input.bedrooms !== undefined ? { bedrooms: input.bedrooms } : {}),
    ...(input.bathrooms !== undefined ? { bathrooms: input.bathrooms } : {}),
    ...(input.floor !== undefined ? { floor: input.floor } : {}),
    ...(input.totalFloors !== undefined ? { totalFloors: input.totalFloors } : {}),
    ...(input.areaSqft !== undefined ? { areaSqft: input.areaSqft } : {}),
    ...(input.rentAmount !== undefined ? { rentAmount: input.rentAmount } : {}),
    ...(input.salePrice !== undefined ? { salePrice: input.salePrice } : {}),
    ...(input.securityDeposit !== undefined ? { securityDeposit: input.securityDeposit } : {}),
    ...(input.maintenanceMonthly !== undefined
      ? { maintenanceMonthly: input.maintenanceMonthly }
      : {}),
    ...(input.availableFrom !== undefined ? { availableFrom: input.availableFrom } : {}),
    ...(input.rules !== undefined ? { rules: input.rules } : {}),
  };
}

export async function createDraft(
  session: RequestSession,
  body: unknown,
): Promise<{ id: string; slug: string }> {
  const input = listingDraftSchema.parse(body);
  const cityId = await resolveCityId(input.citySlug);
  const amenityIds = await resolveAmenityIds(input.amenitySlugs);

  const listing = await prisma.listing.create({
    data: {
      slug: buildSlug(input.citySlug, input.title),
      ownerId: session.userId,
      cityId,
      status: 'DRAFT',
      ...toCreateData(input),
      amenities: { create: amenityIds.map((amenityId) => ({ amenityId })) },
    },
    select: { id: true, slug: true },
  });

  logger.info({ listingId: listing.id, ownerId: session.userId }, 'listing draft created');
  return listing;
}

export async function patchListing(
  session: RequestSession,
  listingId: string,
  body: unknown,
): Promise<{ id: string }> {
  await loadForMutation(session, listingId);

  const input = listingPatchSchema.parse(body);
  const cityId = input.citySlug ? await resolveCityId(input.citySlug) : undefined;
  const amenityIds = input.amenitySlugs ? await resolveAmenityIds(input.amenitySlugs) : undefined;

  await prisma.$transaction(async (tx) => {
    await tx.listing.update({
      where: { id: listingId },
      data: { ...(cityId ? { cityId } : {}), ...toColumnData(input) },
    });

    // Amenities are replaced wholesale: a patch that sends the list means "this
    // is the set now", not "add these".
    if (amenityIds) {
      await tx.listingAmenity.deleteMany({ where: { listingId } });
      await tx.listingAmenity.createMany({
        data: amenityIds.map((amenityId) => ({ listingId, amenityId })),
        skipDuplicates: true,
      });
    }
  });

  return { id: listingId };
}

/**
 * Status transitions, and the one place a role changes.
 *
 * Publishing runs the full publishable schema, not the draft schema: a draft is
 * allowed to be incomplete, a live listing is not.
 */
export async function changeStatus(
  session: RequestSession,
  listingId: string,
  action: ListingStatusAction,
): Promise<{ id: string; status: string; roleUpgraded: boolean }> {
  const listing = await loadForMutation(session, listingId);

  if (action !== 'publish') {
    const status = action === 'pause' ? 'PAUSED' : action === 'unpause' ? 'PUBLISHED' : 'RENTED';

    if (action === 'unpause' && listing.status !== 'PAUSED') {
      throw new HttpError(409, 'not_paused', 'That listing is not paused');
    }

    await prisma.listing.update({ where: { id: listingId }, data: { status } });
    return { id: listingId, status, roleUpgraded: false };
  }

  const full = await prisma.listing.findUniqueOrThrow({
    where: { id: listingId },
    include: { city: { select: { slug: true } }, amenities: { select: { amenityId: true } } },
  });

  const candidate = {
    ...full,
    citySlug: full.city.slug,
    amenitySlugs: [],
    rules: full.rules,
  };

  const validated = publishableListingSchema.safeParse(candidate);

  if (!validated.success) {
    throw new HttpError(
      422,
      'listing_incomplete',
      validated.error.issues
        .map((issue) => `${issue.path.join('.') || 'listing'}: ${issue.message}`)
        .join('; '),
    );
  }

  // READY, not merely present: a PENDING row is an upload the worker has not yet
  // decoded, so publishing on it would put a listing live with no servable photo
  // — or with a file that turns out not to be an image at all.
  const readyPhotos = await prisma.listingImage.count({
    where: { listingId, status: 'READY' },
  });

  if (readyPhotos === 0) {
    const pending = await prisma.listingImage.count({
      where: { listingId, status: 'PENDING' },
    });

    throw new HttpError(
      422,
      'listing_needs_photo',
      pending > 0
        ? 'Your photos are still being processed — try again in a moment'
        : 'Add at least one photo before publishing',
    );
  }

  // A seeker becomes a lister the first time they publish. Done in the same
  // transaction as the publish so the two can never disagree.
  const roleUpgraded = session.role === 'SEEKER';

  await prisma.$transaction(async (tx) => {
    await tx.listing.update({
      where: { id: listingId },
      data: {
        status: 'PUBLISHED',
        // Keep the original publication date on a re-publish.
        publishedAt: full.publishedAt ?? new Date(),
      },
    });

    if (roleUpgraded) {
      await tx.user.update({ where: { id: session.userId }, data: { role: 'LISTER' } });
    }
  });

  logger.info({ listingId, ownerId: full.ownerId, roleUpgraded }, 'listing published');
  return { id: listingId, status: 'PUBLISHED', roleUpgraded };
}

export async function deleteListing(
  session: RequestSession,
  listingId: string,
): Promise<{ id: string }> {
  await loadForMutation(session, listingId);

  // Database rows cascade, but object storage does not: collect the keys BEFORE
  // the rows disappear, or the originals and derivatives are orphaned in the
  // bucket with nothing left pointing at them.
  const objectKeys = await listingObjectKeys(listingId);

  await prisma.listing.delete({ where: { id: listingId } });
  await deleteObjects(objectKeys);

  logger.info({ listingId, actorId: session.userId }, 'listing deleted');
  return { id: listingId };
}

const OWNED_LISTING_SELECT = {
  id: true,
  slug: true,
  title: true,
  status: true,
  listingType: true,
  propertyType: true,
  locality: true,
  bedrooms: true,
  areaSqft: true,
  rentAmount: true,
  salePrice: true,
  isVerified: true,
  viewCount: true,
  createdAt: true,
  updatedAt: true,
  publishedAt: true,
} as const;

/**
 * The lister dashboard's table, with the counts it shows as badges.
 *
 * Scoped to the session user unless an admin asks for someone specific — the
 * ownerId is never read from the query string for a non-admin.
 */
export async function listOwned(
  session: RequestSession,
  options: { status?: string; limit: number; cursor?: string; ownerId?: string },
) {
  const ownerId = session.role === 'ADMIN' && options.ownerId ? options.ownerId : session.userId;

  const listings = await prisma.listing.findMany({
    where: {
      ownerId,
      ...(options.status ? { status: options.status as 'DRAFT' } : {}),
    },
    select: {
      ...OWNED_LISTING_SELECT,
      _count: { select: { enquiries: true, favorites: true, views: true, images: true } },
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  const hasMore = listings.length > options.limit;
  const page = hasMore ? listings.slice(0, options.limit) : listings;

  return {
    listings: page.map((listing) => ({
      ...listing,
      enquiryCount: listing._count.enquiries,
      favoriteCount: listing._count.favorites,
      viewCount: listing.viewCount,
      imageCount: listing._count.images,
      _count: undefined,
    })),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  };
}

/**
 * Public detail read.
 *
 * A listing that is not published is visible only to its owner and to admins —
 * otherwise a guessable slug would leak every draft in the system.
 */
export async function getListingBySlug(slug: string, session?: RequestSession) {
  const listing = await prisma.listing.findUnique({
    where: { slug },
    include: {
      city: { select: { slug: true, name: true, state: true } },
      images: { orderBy: [{ isCover: 'desc' }, { sortOrder: 'asc' }] },
      amenities: { include: { amenity: true } },
      owner: { select: { id: true, name: true, avatarUrl: true, createdAt: true } },
    },
  });

  if (!listing) {
    throw new HttpError(404, 'listing_not_found', 'No such listing');
  }

  const isOwner = session?.userId === listing.ownerId;
  const isAdmin = session?.role === 'ADMIN';

  if (listing.status !== 'PUBLISHED' && !isOwner && !isAdmin) {
    // 404 rather than 403: whether a draft exists at that slug is itself private.
    throw new HttpError(404, 'listing_not_found', 'No such listing');
  }

  // Shaping happens here, not in the route: the image view decides what is
  // publicly fetchable and the owner card decides what is masked, and both must
  // be identical for every caller.
  return {
    listing: {
      ...listing,
      images: listing.images.map((image) => toImageView(image, listing.id)),
      amenities: listing.amenities.map((join) => join.amenity),
      owner: {
        id: listing.owner.id,
        name: listing.owner.name,
        avatarUrl: listing.owner.avatarUrl,
        memberSince: listing.owner.createdAt,
        // Contact details stay masked until an enquiry is sent (step 9).
        phone: null,
      },
    },
    viewerIsOwner: isOwner || isAdmin,
  };
}
