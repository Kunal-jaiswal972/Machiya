import { coverageRequestClusters, prisma } from '@machiya/db';
import { COVERAGE_REQUEST_CLUSTER_METERS } from '@machiya/db';
import type { AdminListing, AdminUser, CoverageDemand } from '@machiya/shared';
import { variantObjectKey } from '@machiya/shared/images';
import { logger } from '../logger.js';
import { publicVariantUrl } from '../lib/storage.js';
import { HttpError } from '../middleware/error-handler.js';
import type { RequestSession } from '../middleware/require-auth.js';

/**
 * The admin surfaces.
 *
 * Every function here is reached only through `requireRole('ADMIN')`, and each
 * of them re-reads the session role rather than trusting the route — the guard
 * decides what renders, the service decides what happens.
 *
 * Two of the three views are not "admin" in the user-management sense at all.
 * The scrape health from step 8 and the coverage-request clusters from D55
 * already existed with nowhere to live, and they answer the two questions an
 * operator actually has: **what is broken**, and **where should we expand**.
 * A page that only lists users answers neither.
 */

function assertAdmin(session: RequestSession): void {
  if (session.role !== 'ADMIN') {
    throw new HttpError(403, 'forbidden_role', 'This action needs ADMIN');
  }
}

/**
 * Published listings, oldest first.
 *
 * Oldest first is the whole point of a queue: a moderator working newest-first
 * leaves the oldest unreviewed listing unreviewed forever.
 *
 * `verified` defaults to false — the queue is the unreviewed ones. Asking for
 * the verified side is what makes unverify reachable: the queue itself cannot
 * offer that toggle, because it would be a button that removes the row it sits
 * on and can never be pressed again.
 */
export async function moderationQueue(
  session: RequestSession,
  options: { limit?: number; verified?: boolean } = {},
): Promise<AdminListing[]> {
  assertAdmin(session);

  const rows = await prisma.listing.findMany({
    where: { status: 'PUBLISHED', isVerified: options.verified ?? false },
    orderBy: { publishedAt: options.verified ? 'desc' : 'asc' },
    take: Math.min(options.limit ?? 50, 100),
    select: {
      id: true,
      slug: true,
      title: true,
      locality: true,
      listingType: true,
      status: true,
      rentAmount: true,
      salePrice: true,
      isVerified: true,
      publishedAt: true,
      city: { select: { slug: true, name: true } },
      owner: { select: { id: true, name: true, email: true, createdAt: true } },
      images: {
        where: { status: 'READY' },
        orderBy: [{ isCover: 'desc' }, { sortOrder: 'asc' }],
        take: 1,
        select: { variantBaseKey: true },
      },
      _count: { select: { images: true, enquiries: true } },
    },
  });

  return rows.map((row) => {
    const base = row.images[0]?.variantBaseKey;

    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      locality: row.locality,
      listingType: row.listingType,
      status: row.status,
      rentAmount: row.rentAmount,
      salePrice: row.salePrice,
      isVerified: row.isVerified,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      citySlug: row.city.slug,
      cityName: row.city.name,
      owner: {
        id: row.owner.id,
        name: row.owner.name,
        email: row.owner.email,
        // A brand-new account publishing immediately is the shape of a spam
        // run, so the moderator gets to see it without opening another page.
        memberSince: row.owner.createdAt.toISOString(),
      },
      imageCount: row._count.images,
      enquiryCount: row._count.enquiries,
      coverUrl: base ? publicVariantUrl(variantObjectKey(base, 'card', 'webp')) : null,
    };
  });
}

export async function setListingVerified(
  session: RequestSession,
  listingId: string,
  isVerified: boolean,
): Promise<{ id: string; isVerified: boolean }> {
  assertAdmin(session);

  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: { id: true },
  });

  if (!listing) {
    throw new HttpError(404, 'listing_not_found', 'No such listing');
  }

  await prisma.listing.update({ where: { id: listingId }, data: { isVerified } });
  logger.info({ listingId, isVerified, actorId: session.userId }, 'listing verification changed');

  return { id: listingId, isVerified };
}

/**
 * Users, for the admin plugin's ban and role controls.
 *
 * The list is served from here rather than from Better Auth's own
 * `/admin/list-users`, because the useful columns are ours: how many listings
 * they own and how many enquiries they are sitting on. The BAN and role writes
 * still go through the plugin's endpoints, which own the session revocation
 * that a role change has to trigger.
 */
export async function listUsers(
  session: RequestSession,
  options: { query?: string; limit?: number } = {},
): Promise<AdminUser[]> {
  assertAdmin(session);

  const term = options.query?.trim();

  const rows = await prisma.user.findMany({
    where: term
      ? {
          OR: [
            { email: { contains: term, mode: 'insensitive' } },
            { name: { contains: term, mode: 'insensitive' } },
          ],
        }
      : {},
    orderBy: { createdAt: 'desc' },
    take: Math.min(options.limit ?? 50, 100),
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      emailVerified: true,
      banned: true,
      banReason: true,
      createdAt: true,
      _count: { select: { listings: true, enquiriesAsLister: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    emailVerified: row.emailVerified,
    banned: row.banned ?? false,
    banReason: row.banReason,
    createdAt: row.createdAt.toISOString(),
    listingCount: row._count.listings,
    enquiryCount: row._count.enquiriesAsLister,
  }));
}

/**
 * Where people are asking us to go next.
 *
 * The point of D55's table, finally rendered. Ranked by distinct PEOPLE, not by
 * rows and not by asks: a table of taps would let one determined person choose
 * the fourth city.
 */
export async function coverageDemand(session: RequestSession): Promise<CoverageDemand> {
  assertAdmin(session);

  const clusters = await coverageRequestClusters(20);

  return {
    clusterRadiusMeters: COVERAGE_REQUEST_CLUSTER_METERS,
    clusters: clusters.map((cluster) => ({
      lat: cluster.lat,
      lng: cluster.lng,
      people: cluster.people,
      asks: cluster.asks,
      label: cluster.label,
      firstAskedAt: cluster.firstAskedAt.toISOString(),
      lastAskedAt: cluster.lastAskedAt.toISOString(),
    })),
  };
}
