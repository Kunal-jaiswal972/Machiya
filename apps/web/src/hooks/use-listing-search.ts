import {
  buildSearchParams,
  commutePreferencesToQuery,
  searchResponseSchema,
  type ListingCard,
  type OutOfCoverage,
  type SearchQuery,
} from '@machiya/shared';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { useCommutePreferencesStore } from '../stores/commute-preferences';

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
  /**
   * Set when the office is somewhere the product does not reach.
   *
   * Read this BEFORE `listings` and `total`: they are zero and empty in this
   * state, and rendering them would say "no listings near you" about a city
   * that was never searched. The response is a discriminated union server-side
   * for exactly that reason; this is the client half of it.
   */
  outOfCoverage: OutOfCoverage | null;
}

async function fetchPage(query: SearchQuery, commute: Record<string, string>, signal: AbortSignal) {
  const params = buildSearchParams(query);
  params.set('limit', String(LIST_PAGE_SIZE));
  // Deliberately NOT in `buildSearchParams`: these are settings, not search
  // state, so they must not end up in a shared link. They are here because the
  // total-cost figure on every card is computed from them, and a URL that does
  // not say so is a URL that gets cached against the wrong answer (D76).
  for (const [key, value] of Object.entries(commute)) params.set(key, value);

  return apiFetch(`/api/listings/search?${params.toString()}`, searchResponseSchema, {
    signal,
  });
}

export function useListingSearch(query: SearchQuery): ListingSearchState {
  const hasOffice = query.lat !== undefined && query.lng !== undefined;
  const preferences = useCommutePreferencesStore((state) => state.preferences);
  const commuteQuery = commutePreferencesToQuery(preferences);

  // The cursor is NOT part of the key: React Query owns paging, and leaving a
  // cursor in the key would make every page a separate cache entry that the
  // next filter change orphans.
  const { cursor: _cursor, ...keyable } = query;

  const result = useInfiniteQuery({
    queryKey: ['listings', 'search', keyable, commuteQuery],
    enabled: hasOffice,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchPage({ ...query, ...(pageParam ? { cursor: pageParam } : {}) }, commuteQuery, signal),
    // No next page out of coverage: there is nothing to page through, and
    // asking for one would loop on the same refusal.
    getNextPageParam: (lastPage) =>
      lastPage.status === 'ok' ? (lastPage.nextCursor ?? undefined) : undefined,
    // A search is cheap to re-run and listings do get published, but re-running
    // it on every remount would refetch while the user is reading a card.
    staleTime: 30_000,
    placeholderData: (previous) =>
      previous as InfiniteData<Awaited<ReturnType<typeof fetchPage>>, string | undefined>,
  });

  const pages = result.data?.pages ?? [];
  const ok = pages.filter(
    (page): page is Extract<typeof page, { status: 'ok' }> => page.status === 'ok',
  );
  const last = ok.at(-1);

  // Only the FIRST page can be out of coverage — the office does not move
  // between pages — so this reads page one rather than the latest.
  const refused = pages[0]?.status === 'out_of_coverage' ? pages[0].coverage : null;

  return {
    listings: ok.flatMap((page) => page.listings),
    // Totals and ring counts describe the whole filtered set, so any page's
    // copy is the same answer. The latest is used in case a page arrived after
    // a listing was published.
    total: last?.total ?? 0,
    ringCounts: last?.ringCounts ?? { 1: 0, 2: 0, 3: 0 },
    outOfCoverage: refused,
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
