import { prisma } from '@machiya/db';
import { VIEW_DEDUPE_WINDOW_MINUTES, type ListerAnalytics } from '@machiya/shared';
import type { RequestSession } from '../middleware/require-auth.js';

/**
 * What a lister's dashboard charts, and what the numbers actually mean.
 *
 * The daily series counts `ListingView` **rows**, and a row is one viewer per
 * thirty-minute window with the owner excluded (D44). That is not the same as
 * "page loads", and a chart that silently meant page loads would be worse than
 * no chart — so the number is served with the definition attached
 * (`viewWindowMinutes`, `excludesOwner`) and the card states it in words rather
 * than leaving the reader to assume.
 *
 * Enquiry conversion is enquiries over views across the same window. It is a
 * ratio of two things measured differently — an enquiry is a person, a view is
 * a person-window — so `enquiriesPerHundredViews` is deliberately named for
 * what it divides rather than called a "conversion rate", which implies a
 * funnel this data does not observe.
 */
const DEFAULT_DAYS = 30;

export async function getListerAnalytics(
  session: RequestSession,
  options: { days?: number; ownerId?: string } = {},
): Promise<ListerAnalytics> {
  const days = Math.min(Math.max(options.days ?? DEFAULT_DAYS, 7), 90);
  const ownerId = session.role === 'ADMIN' && options.ownerId ? options.ownerId : session.userId;

  const since = new Date(Date.now() - days * 86_400_000);
  since.setUTCHours(0, 0, 0, 0);

  const owned = await prisma.listing.findMany({
    where: { ownerId },
    select: { id: true, status: true },
  });

  const listingIds = owned.map((listing) => listing.id);

  if (listingIds.length === 0) {
    return {
      days,
      viewWindowMinutes: VIEW_DEDUPE_WINDOW_MINUTES,
      excludesOwner: true,
      series: [],
      totals: {
        views: 0,
        enquiries: 0,
        favorites: 0,
        published: 0,
        drafts: 0,
        enquiriesPerHundredViews: null,
      },
    };
  }

  const [viewRows, enquiryRows, favorites] = await Promise.all([
    prisma.listingView.groupBy({
      by: ['viewedAt'],
      where: { listingId: { in: listingIds }, viewedAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.enquiry.findMany({
      where: { listingId: { in: listingIds }, createdAt: { gte: since } },
      select: { createdAt: true },
    }),
    prisma.favorite.count({ where: { listingId: { in: listingIds } } }),
  ]);

  // Bucketed in JS rather than with date_trunc, because `groupBy` cannot
  // express a truncation and this is the one place in the codebase that would
  // otherwise need a second raw-SQL home — every line of raw SQL lives in
  // packages/db/src/geo-queries.ts, and a lister's chart is not a geo query.
  const buckets = new Map<string, { views: number; enquiries: number }>();

  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(since.getTime() + offset * 86_400_000);
    buckets.set(dayKey(day), { views: 0, enquiries: 0 });
  }

  for (const row of viewRows) {
    const bucket = buckets.get(dayKey(row.viewedAt));
    if (bucket) bucket.views += row._count._all;
  }

  for (const row of enquiryRows) {
    const bucket = buckets.get(dayKey(row.createdAt));
    if (bucket) bucket.enquiries += 1;
  }

  const series = [...buckets.entries()].map(([date, counts]) => ({ date, ...counts }));
  const views = series.reduce((sum, point) => sum + point.views, 0);
  const enquiries = series.reduce((sum, point) => sum + point.enquiries, 0);

  return {
    days,
    viewWindowMinutes: VIEW_DEDUPE_WINDOW_MINUTES,
    excludesOwner: true,
    series,
    totals: {
      views,
      enquiries,
      favorites,
      published: owned.filter((listing) => listing.status === 'PUBLISHED').length,
      drafts: owned.filter((listing) => listing.status === 'DRAFT').length,
      // Null rather than zero with no views: "0 enquiries per 100 views" claims
      // a measurement that was never taken.
      enquiriesPerHundredViews: views === 0 ? null : Math.round((enquiries / views) * 1000) / 10,
    },
  };
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
