import {
  favoriteIdsResponseSchema,
  favoriteToggleResponseSchema,
  favoritesResponseSchema,
  savedSearchesResponseSchema,
  type SavedSearchInput,
} from '@machiya/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth-context';

const FAVORITE_IDS_KEY = ['favorites', 'ids'] as const;
const FAVORITES_KEY = ['favorites', 'list'] as const;
const SAVED_SEARCHES_KEY = ['saved-searches'] as const;

export function useFavorites() {
  const { isSignedIn } = useAuth();

  return useQuery({
    queryKey: FAVORITES_KEY,
    queryFn: async () => (await apiFetch('/api/favorites', favoritesResponseSchema)).favorites,
    enabled: isSignedIn,
  });
}

/** Just the ids, so the heart on every card costs one request rather than N. */
export function useFavoriteIds() {
  const { isSignedIn } = useAuth();

  const query = useQuery({
    queryKey: FAVORITE_IDS_KEY,
    queryFn: async () =>
      (await apiFetch('/api/favorites/ids', favoriteIdsResponseSchema)).listingIds,
    enabled: isSignedIn,
    staleTime: 60_000,
  });

  return new Set(query.data ?? []);
}

/**
 * The heart, toggled optimistically.
 *
 * The outcome is near-certain — the write is an upsert on the caller's own row
 * with nothing to validate — which is the condition docs/design.md sets for an
 * optimistic mutation. The rollback restores the exact previous set rather than
 * inverting the toggle again, so two fast taps cannot leave it inverted.
 */
export function useToggleFavorite() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ listingId, next }: { listingId: string; next: boolean }) =>
      apiFetch(`/api/favorites/${listingId}`, favoriteToggleResponseSchema, {
        method: next ? 'PUT' : 'DELETE',
      }),
    onMutate: async ({ listingId, next }) => {
      await queryClient.cancelQueries({ queryKey: FAVORITE_IDS_KEY });
      const previous = queryClient.getQueryData<string[]>(FAVORITE_IDS_KEY);

      queryClient.setQueryData<string[]>(FAVORITE_IDS_KEY, (ids = []) =>
        next ? [...new Set([...ids, listingId])] : ids.filter((id) => id !== listingId),
      );

      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(FAVORITE_IDS_KEY, context.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: FAVORITE_IDS_KEY });
      void queryClient.invalidateQueries({ queryKey: FAVORITES_KEY });
    },
  });
}

export function useSavedSearches() {
  const { isSignedIn } = useAuth();

  return useQuery({
    queryKey: SAVED_SEARCHES_KEY,
    queryFn: async () =>
      (await apiFetch('/api/saved-searches', savedSearchesResponseSchema)).searches,
    enabled: isSignedIn,
  });
}

const createdSchema = z.object({ id: z.string() });

export function useCreateSavedSearch() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: SavedSearchInput) =>
      apiFetch('/api/saved-searches', createdSchema, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SAVED_SEARCHES_KEY });
    },
  });
}

export function useDeleteSavedSearch() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/saved-searches/${id}`, createdSchema, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SAVED_SEARCHES_KEY });
    },
  });
}
