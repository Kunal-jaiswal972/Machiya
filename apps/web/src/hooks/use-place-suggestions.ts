import {
  AUTOCOMPLETE_DEBOUNCE_MS,
  CACHE_TTL_SECONDS,
  type GeocodeResult,
  type OutOfCoverage,
  type PlaceSuggestionState,
} from '@machiya/shared';
import { useQuery } from '@tanstack/react-query';
import { fetchPlaceSuggestions } from '../lib/places';
import { useDebouncedValue } from './use-debounced-value';

/**
 * The client half of the two-tier autocomplete (DECISIONS.md D39).
 *
 * Three things keep this from hammering the endpoint, and each matters:
 *
 *  - the query is debounced by 250 ms, so a burst of keystrokes is one request
 *    rather than one per character.
 *  - the in-flight request is aborted when the term changes. React Query passes
 *    an `AbortSignal` into the query function and cancels it when the key moves,
 *    so this is inherited rather than hand-rolled — and the API forwards that
 *    abort to Nominatim, so a cancelled keystroke stops work upstream too.
 *  - `placeholderData` holds the previous list on screen while the next one
 *    loads. Without it the dropdown empties and re-fills on every pause, which
 *    reads as flicker and makes the list feel slower than it is.
 *
 * Single characters are not sent at all: the server would answer from the local
 * tier only, and the answer would be almost every locality in the city.
 */
export interface PlaceSuggestionsState {
  suggestions: GeocodeResult[];
  isLoading: boolean;
  /**
   * One of three, never a pair of booleans — see `placeSuggestionStateSchema`.
   * `degraded` means the remote tier could not answer; `out_of_coverage` means
   * both tiers answered and the place is somewhere we do not serve. The old
   * code had one flag for both, which is how "we don't cover Mumbai" got
   * rendered as "the wider search is unavailable".
   */
  state: PlaceSuggestionState;
  /** Present only when `state` is `out_of_coverage`. */
  coverage: OutOfCoverage | null;
}

export function usePlaceSuggestions(input: {
  query: string;
  citySlug?: string;
  limit?: number;
  enabled?: boolean;
}): PlaceSuggestionsState {
  const term = input.query.trim();
  const debounced = useDebouncedValue(term, AUTOCOMPLETE_DEBOUNCE_MS);
  const enabled = (input.enabled ?? true) && debounced.length >= 2;

  const query = useQuery({
    queryKey: ['places', 'suggest', debounced, input.citySlug ?? null, input.limit ?? 8],
    queryFn: ({ signal }) =>
      fetchPlaceSuggestions(
        {
          query: debounced,
          ...(input.citySlug ? { citySlug: input.citySlug } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
        },
        signal,
      ),
    enabled,
    // The server caches these for a week; there is no reason for the client to
    // re-ask within a session.
    staleTime: CACHE_TTL_SECONDS.geocode * 1000,
    placeholderData: (previous) => previous,
  });

  return {
    suggestions: enabled ? (query.data?.suggestions ?? []) : [],
    isLoading: enabled && query.isFetching,
    // `ok` while disabled or in flight: a message about coverage or a degraded
    // tier must not flash up for a query that has not been answered yet.
    state: enabled && !query.isFetching ? (query.data?.state ?? 'ok') : 'ok',
    coverage: query.data?.coverage ?? null,
  };
}
