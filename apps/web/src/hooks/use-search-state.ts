import {
  buildSearchParams,
  countActiveFilters,
  parseSearchQuery,
  type SearchQuery,
} from '@machiya/shared';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

/**
 * The URL is the search state, and this is the only thing that writes it.
 *
 * Consequences worth stating, because they are the reason for doing it this way
 * rather than holding search state in a store:
 *
 *  - a search is shareable by copying the address bar, filters and all;
 *  - back and forward step through filter changes, which is what a user expects
 *    from something that looks like navigation;
 *  - there is no second copy of the state to fall out of step with the first.
 *
 * Encoding lives in `@machiya/shared/search-params` so the server parses exactly
 * what the client wrote.
 */
export interface SearchStateApi {
  query: SearchQuery;
  /** Null until an office is chosen; the whole search is anchored to it. */
  office: { lat: number; lng: number } | null;
  radiusMeters: number;
  activeFilterCount: number;
  /**
   * Merge a patch into the query. `undefined` clears a key.
   *
   * Any change except paging resets the cursor: keeping a cursor from the
   * previous filter set would page through a result set that no longer exists.
   */
  update: (patch: Partial<SearchQuery>, options?: { replace?: boolean }) => void;
  setOffice: (point: { lat: number; lng: number } | null) => void;
  clearFilters: () => void;
}

const FILTER_KEYS: Array<keyof SearchQuery> = [
  'type',
  'property',
  'furnishing',
  'amenities',
  'priceMin',
  'priceMax',
  'bedsMin',
  'bedsMax',
  'bathsMin',
  'areaMin',
  'areaMax',
  'availableBy',
  'ring',
  'verified',
  'q',
];

export function useSearchState(): SearchStateApi {
  const [searchParams, setSearchParams] = useSearchParams();

  const query = useMemo<SearchQuery>(() => {
    try {
      return parseSearchQuery(Object.fromEntries(searchParams));
    } catch {
      // A hand-edited or truncated URL must not white-screen the app. Fall back
      // to an empty search — the office field is then the obvious next action.
      return parseSearchQuery({});
    }
  }, [searchParams]);

  const update = useCallback(
    (patch: Partial<SearchQuery>, options?: { replace?: boolean }) => {
      const next: SearchQuery = { ...query, ...patch };

      // Paging is the one change that keeps its cursor.
      if (!('cursor' in patch)) {
        delete next.cursor;
      }

      setSearchParams(buildSearchParams(next), {
        // Filter changes replace rather than push: a user who tried four price
        // ranges should not have to press back four times to leave the page.
        // Choosing an office pushes, because that IS a navigation.
        replace: options?.replace ?? true,
      });
    },
    [query, setSearchParams],
  );

  const setOffice = useCallback(
    (point: { lat: number; lng: number } | null) => {
      update(point ? { lat: point.lat, lng: point.lng } : { lat: undefined, lng: undefined }, {
        replace: false,
      });
    },
    [update],
  );

  const clearFilters = useCallback(() => {
    const cleared = Object.fromEntries(FILTER_KEYS.map((key) => [key, undefined]));
    update(cleared as Partial<SearchQuery>);
  }, [update]);

  return {
    query,
    office:
      query.lat === undefined || query.lng === undefined
        ? null
        : { lat: query.lat, lng: query.lng },
    radiusMeters: query.radius ?? 3000,
    activeFilterCount: countActiveFilters(query),
    update,
    setOffice,
    clearFilters,
  };
}
