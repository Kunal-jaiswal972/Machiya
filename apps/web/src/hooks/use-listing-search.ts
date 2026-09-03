import {
  buildSearchParams,
  listingSearchResponseSchema,
  type ListingCard,
  type SearchQuery,
} from '@machiya/shared';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';

/**
 * The radius search, paged by the API's keyset cursor.
 *
 * Two page sizes on purpose, and it matters:
 *  - the LIST pages, 24 at a time, because a user scrolls it;
 *  - the MAP wants the whole radius at once, because a marker that appears when
 *    you scroll a list is a marker that was lying about where listings are.
 *
 * So `useListingSearch` serves the list, and `mapListings` returns everything
 * fetched so far — the map catches up as pages load, which is honest, and the
 * first page already covers the dense middle.
 */
const LIST_PAGE_SIZE = 24;

export interface ListingSearchState {
  listings: ListingCard[];
  total: number;
  ringCounts: Record<1 | 2 | 3, number>;
  isLoading: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  error: Error | null;
}

async function fetchPage(query: SearchQuery, signal: AbortSignal) {
  const params = buildSearchParams(query);
  params.set('limit', String(LIST_PAGE_SIZE));

  return apiFetch(`/api/listings/search?${params.toString()}`, listingSearchResponseSchema, {
    signal,
  });
}

export function useListingSearch(query: SearchQuery): ListingSearchState {
  const hasOffice = query.lat !== undefined && query.lng !== undefined;

  // The cursor is NOT part of the key: React Query owns paging, and leaving a
  // cursor in the key would make every page a separate cache entry that the
  // next filter change orphans.
  const { cursor: _cursor, ...keyable } = query;

  const result = useInfiniteQuery({
    queryKey: ['listings', 'search', keyable],
    enabled: hasOffice,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchPage({ ...query, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // A search is cheap to re-run and listings do get published, but re-running
    // it on every remount would refetch while the user is reading a card.
    staleTime: 30_000,
    placeholderData: (previous) =>
      previous as InfiniteData<Awaited<ReturnType<typeof fetchPage>>, string | undefined>,
  });

  const pages = result.data?.pages ?? [];
  const last = pages.at(-1);

  return {
    listings: pages.flatMap((page) => page.listings),
    // Totals and ring counts describe the whole filtered set, so any page's
    // copy is the same answer. The latest is used in case a page arrived after
    // a listing was published.
    total: last?.total ?? 0,
    ringCounts: last?.ringCounts ?? { 1: 0, 2: 0, 3: 0 },
    isLoading: hasOffice && result.isPending,
    isFetchingNextPage: result.isFetchingNextPage,
    hasNextPage: result.hasNextPage,
    fetchNextPage: () => {
      if (result.hasNextPage && !result.isFetchingNextPage) {
        void result.fetchNextPage();
      }
    },
    error: result.error,
  };
}
