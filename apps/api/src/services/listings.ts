import { randomBytes } from 'node:crypto';
import { prisma } from '@machiya/db';
import {
  listingDraftSchema,
  listingDraftStartSchema,
  listingPatchSchema,
  missingPublishFields,
  publishableListingSchema,
  type ListingDraft,
  type ListingDraftView,
  type ListingPatch,
  type ListingStatusAction,
} from '@machiya/shared';
import { logger } from '../logger.js';
import { HttpError } from '../middleware/error-handler.js';
import { deleteObjects } from '../lib/storage.js';
import { assertOwnership, type RequestSession } from '../middleware/require-auth.js';
import { resolveAmenityIds } from './amenities.js';
import { assertCovered } from './coverage.js';
import { listingObjectKeys, toImageView } from './listing-images.js';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function slugSuffix(): string {
  return randomBytes(4)
    .toString('base64url')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 6);
}

/**
 * Slugs are user-visible, so they carry the city and title — but they must also
 * be unique across every listing ever created, including two identical titles in
 * the same locality. A short random suffix buys that without a retry loop.
 */
function buildSlug(citySlug: string, title: string): string {
  return `${citySlug}-${slugify(title)}-${slugSuffix()}`;
}

const DRAFT_SLUG_PREFIX = 'draft-';

/**
 * A draft opened from a pin alone has no title to name it with, so it gets a
 * placeholder that is obviously one.
 *
 * The prefix is what `changeStatus` later reads to decide whether the slug is
 * still up for grabs: a listing that has ever been published keeps its URL
 * forever, because a slug that changes under a shared link is a broken link.
 */
function buildDraftSlug(citySlug: string): string {
  return `${DRAFT_SLUG_PREFIX}${citySlug}-${slugSuffix()}`;
}

async function resolveCityId(citySlug: string): Promise<string> {
  const city = await prisma.city.findUnique({ where: { slug: citySlug }, select: { id: true } });

  if (!city) {
    throw new HttpError(400, 'unknown_city', `No city with the slug "${citySlug}"`);
  }

  return city.id;
}

/**
 * Which city a listing belongs to, decided by its COORDINATES — and refused
 * outright when those coordinates are outside coverage.
 *
 * The client sends a `citySlug` and it is treated as a hint, not as the
 * answer: a wizard's city dropdown and a map pin can disagree, and when they
 * do the pin is the fact.
 *
 * `assertCovered` is the gate correction 9 added, and it is the difference
 * between a bad row and no row. Before it, a pin dropped in Mumbai was accepted
 * and filed under Pune by the nearest-centroid fallback — 1,300 km of "nearest"
 * — so the listing existed, was invisible in every search anyone would run for
 * it, and looked perfectly healthy in the database. **Inside** coverage the
 * same fallback is correct for a point in a gap between two boundaries and it
 * stays; across the coverage frontier it is silent data corruption. See
 * DECISIONS.md D53.
 *
 * The remaining disagreement — a covered pin in a different city than the one
 * claimed — is logged rather than refused: it is either a user error or a
 * boundary that needs re-deriving, and a pattern in the logs is how that gets
 * noticed before it becomes a support ticket.
 */
async function resolveCityForListing(input: {
  citySlug: string;
  lat: number;
  lng: number;
}): Promise<{ id: string; slug: string }> {
  // The claimed slug still has to EXIST, even though it does not decide the
  // answer: a request naming a city this deployment does not serve is a client
  // bug, and letting the coordinates quietly paper over it would hide the one
  // case where the client and the server disagree about the world.
  await resolveCityId(input.citySlug);

  const city = await assertCovered({ lat: input.lat, lng: input.lng });

  if (city.slug !== input.citySlug) {
    logger.warn(
      { claimed: input.citySlug, assigned: city.slug, method: city.method },
      'listing coordinates fall in a different city than the one submitted; the coordinates win',
    );
  }

  return { id: city.id, slug: city.slug };
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

/**
 * Patch variant: only the keys actually sent reach the UPDATE.
 *
 * Takes the nullable draft shape rather than `Partial<ListingDraft>` because
 * `undefined` and `null` mean different things here — "this step did not touch
 * the field" against "the user emptied it" — and collapsing them would make a
 * cleared title unclearable.
 */
function toColumnData(input: ListingPatch) {
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

/**
 * Opens a listing.
 *
 * Two shapes, because there are two callers with genuinely different
 * information. The wizard sends only what its location step produced — a pin,
 * the city it resolved to, and whatever the reverse geocode was willing to name
 * — and gets back a draft it can autosave into from then on. Anything sending a
 * complete listing (a test, a seed, an importer) still gets today's behaviour,
 * slug and all.
 *
 * The two are told apart by whether a `title` is present, which is the first
 * field the full schema requires and the last thing the wizard has.
 */
export async function createDraft(
  session: RequestSession,
  body: unknown,
): Promise<{ id: string; slug: string }> {
  const wantsFullCreate =
    typeof body === 'object' && body !== null && 'title' in body && Boolean(body.title);

  if (!wantsFullCreate) {
    const start = listingDraftStartSchema.parse(body);
    const city = await resolveCityForListing(start);

    const draft = await prisma.listing.create({
      data: {
        slug: buildDraftSlug(city.slug),
        ownerId: session.userId,
        cityId: city.id,
        status: 'DRAFT',
        lat: start.lat,
        lng: start.lng,
        // D59: the street line is left EMPTY rather than filled with an
        // approximation, and the locality only arrives when the reverse
        // geocode actually resolved one.
        address: start.address ?? null,
        locality: start.locality ?? null,
      },
      select: { id: true, slug: true },
    });

    logger.info(
      { listingId: draft.id, ownerId: session.userId },
      'listing draft opened from a pin',
    );
    return draft;
  }

  const input = listingDraftSchema.parse(body);
  const city = await resolveCityForListing(input);
  const amenityIds = await resolveAmenityIds(input.amenitySlugs);

  const listing = await prisma.listing.create({
    data: {
      // The RESOLVED city in the slug, not the claimed one: a listing whose URL
      // says one city and whose row says another is the kind of inconsistency
      // that surfaces months later as a broken filter.
      slug: buildSlug(city.slug, input.title),
      ownerId: session.userId,
      cityId: city.id,
      status: 'DRAFT',
      ...toCreateData(input),
      amenities: { create: amenityIds.map((amenityId) => ({ amenityId })) },
    },
    select: { id: true, slug: true },
  });

  logger.info({ listingId: listing.id, ownerId: session.userId }, 'listing draft created');
  return listing;
}

/**
 * The wizard's read: the whole draft, as the server holds it.
 *
 * The client keeps nothing that matters, which is what makes a draft survive a
 * closed tab and reopen on another device. Owner-only — an admin passes through
 * `assertOwnership` like everywhere else.
 */
export async function getDraft(
  session: RequestSession,
  listingId: string,
): Promise<ListingDraftView> {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    include: {
      city: { select: { slug: true, name: true } },
      amenities: { select: { amenity: { select: { slug: true } } } },
      images: { orderBy: { sortOrder: 'asc' } },
    },
  });

  if (!listing) {
    throw new HttpError(404, 'listing_not_found', 'No such listing');
  }

  assertOwnership(session, listing.ownerId);

  return {
    id: listing.id,
    slug: listing.slug,
    status: listing.status,
    citySlug: listing.city.slug,
    cityName: listing.city.name,
    lat: listing.lat,
    lng: listing.lng,
    address: listing.address,
    locality: listing.locality,
    title: listing.title,
    description: listing.description,
    listingType: listing.listingType,
    propertyType: listing.propertyType,
    furnishing: listing.furnishing,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    floor: listing.floor,
    totalFloors: listing.totalFloors,
    areaSqft: listing.areaSqft,
    rentAmount: listing.rentAmount,
    salePrice: listing.salePrice,
    securityDeposit: listing.securityDeposit,
    maintenanceMonthly: listing.maintenanceMonthly,
    availableFrom: listing.availableFrom?.toISOString() ?? null,
    rules: listing.rules,
    amenitySlugs: listing.amenities.map((join) => join.amenity.slug),
    images: listing.images.map((image) => toImageView(image, listing.id)),
    publishedAt: listing.publishedAt?.toISOString() ?? null,
    updatedAt: listing.updatedAt.toISOString(),
  };
}

export async function patchListing(
  session: RequestSession,
  listingId: string,
  body: unknown,
): Promise<{ id: string }> {
  await loadForMutation(session, listingId);

  const input = listingPatchSchema.parse(body);
  const amenityIds = input.amenitySlugs ? await resolveAmenityIds(input.amenitySlugs) : undefined;

  // Re-resolve whenever the PIN moves, not only when the city dropdown does:
  // dragging a marker across a municipal border is exactly the edit that
  // silently leaves a listing filed under the wrong city.
  const moved = input.lat !== undefined && input.lng !== undefined;
  const cityId =
    moved || input.citySlug
      ? await (async () => {
          if (moved) {
            const existing = await prisma.listing.findUniqueOrThrow({
              where: { id: listingId },
              select: { city: { select: { slug: true } } },
            });
            const resolved = await resolveCityForListing({
              citySlug: input.citySlug ?? existing.city.slug,
              lat: input.lat as number,
              lng: input.lng as number,
            });
            return resolved.id;
          }
          return resolveCityId(input.citySlug as string);
        })()
      : undefined;

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
): Promise<{ id: string; status: string; slug: string; roleUpgraded: boolean }> {
  const listing = await loadForMutation(session, listingId);

  if (action !== 'publish') {
    const status = action === 'pause' ? 'PAUSED' : action === 'unpause' ? 'PUBLISHED' : 'RENTED';

    if (action === 'unpause' && listing.status !== 'PAUSED') {
      throw new HttpError(409, 'not_paused', 'That listing is not paused');
    }

    await prisma.listing.update({ where: { id: listingId }, data: { status } });
    return { id: listingId, status, slug: listing.slug, roleUpgraded: false };
  }

  const full = await prisma.listing.findUniqueOrThrow({
    where: { id: listingId },
    include: {
      city: { select: { slug: true } },
      amenities: { select: { amenity: { select: { slug: true } } } },
    },
  });

  // Which fields are still EMPTY, before which combinations are incoherent.
  // A draft missing a title fails the strict schema with "expected string,
  // received null", which tells a lister nothing about where to go.
  const missing = missingPublishFields(full);

  if (missing.length > 0) {
    throw new HttpError(
      422,
      'listing_incomplete',
      missing.map((requirement) => requirement.message).join('; '),
    );
  }

  const candidate = {
    ...full,
    citySlug: full.city.slug,
    // The listing's real amenities, not an empty list. Nothing in the strict
    // schema reads them today, but handing a validator a value that is not
    // true is how a future rule gets written against a lie.
    amenitySlugs: full.amenities.map((join) => join.amenity.slug),
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

  // A draft opened from a pin has a placeholder slug and no public URL yet, so
  // this is the one moment it can be named from the title the lister settled
  // on. After that the slug is frozen: a URL that changes under a shared link
  // is a broken link, whatever the listing was later renamed to.
  const slug =
    full.publishedAt === null && full.slug.startsWith(DRAFT_SLUG_PREFIX)
      ? buildSlug(full.city.slug, validated.data.title)
      : full.slug;

  await prisma.$transaction(async (tx) => {
    await tx.listing.update({
      where: { id: listingId },
      data: {
        status: 'PUBLISHED',
        slug,
        // Keep the original publication date on a re-publish.
        publishedAt: full.publishedAt ?? new Date(),
      },
    });

    if (roleUpgraded) {
      await tx.user.update({ where: { id: session.userId }, data: { role: 'LISTER' } });
    }
  });

  logger.info({ listingId, ownerId: full.ownerId, roleUpgraded, slug }, 'listing published');
  return { id: listingId, status: 'PUBLISHED', slug, roleUpgraded };
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
    listings: page.map(({ _count, ...listing }) => ({
      ...listing,
      createdAt: listing.createdAt.toISOString(),
      updatedAt: listing.updatedAt.toISOString(),
      publishedAt: listing.publishedAt?.toISOString() ?? null,
      enquiryCount: _count.enquiries,
      favoriteCount: _count.favorites,
      imageCount: _count.images,
    })),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  };
}

/**
 * Copies a listing as a fresh draft.
 *
 * Photos are deliberately NOT copied. The variant objects belong to the source
 * listing's key prefix, so pointing a second row at them would make deleting
 * either listing blank the other's gallery — the exact hazard
 * `isListingOwnedVariantBase` exists to prevent (D41). Re-uploading is a few
 * seconds; a silently shared gallery is a bug that surfaces months later.
 *
 * Everything else is copied, including the amenities and the pin, because the
 * reason to duplicate is almost always "the flat upstairs".
 */
export async function duplicateListing(
  session: RequestSession,
  listingId: string,
): Promise<{ id: string; slug: string }> {
  const source = await prisma.listing.findUnique({
    where: { id: listingId },
    include: {
      city: { select: { slug: true } },
      amenities: { select: { amenityId: true } },
    },
  });

  if (!source) {
    throw new HttpError(404, 'listing_not_found', 'No such listing');
  }

  assertOwnership(session, source.ownerId);

  const copy = await prisma.listing.create({
    data: {
      // A draft slug, so publishing names the copy from ITS final title rather
      // than from the original's (D67).
      slug: buildDraftSlug(source.city.slug),
      ownerId: source.ownerId,
      cityId: source.cityId,
      status: 'DRAFT',
      title: source.title === null ? null : `${source.title} (copy)`,
      description: source.description,
      listingType: source.listingType,
      propertyType: source.propertyType,
      furnishing: source.furnishing,
      address: source.address,
      locality: source.locality,
      lat: source.lat,
      lng: source.lng,
      bedrooms: source.bedrooms,
      bathrooms: source.bathrooms,
      floor: source.floor,
      totalFloors: source.totalFloors,
      areaSqft: source.areaSqft,
      rentAmount: source.rentAmount,
      salePrice: source.salePrice,
      securityDeposit: source.securityDeposit,
      maintenanceMonthly: source.maintenanceMonthly,
      availableFrom: source.availableFrom,
      rules: source.rules,
      amenities: {
        create: source.amenities.map((join) => ({ amenityId: join.amenityId })),
      },
    },
    select: { id: true, slug: true },
  });

  logger.info({ listingId: copy.id, copiedFrom: listingId }, 'listing duplicated');
  return copy;
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
