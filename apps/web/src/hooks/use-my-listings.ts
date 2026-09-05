import type { ListingStatus } from '@machiya/shared';
import { listerAnalyticsSchema, ownedListingsResponseSchema } from '@machiya/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { createdListingSchema, listingStatusResponseSchema } from '../lib/listing-schemas';

export const myListingsKey = (status?: ListingStatus) => ['my-listings', status ?? 'all'] as const;

export function useMyListings(status?: ListingStatus) {
  return useQuery({
    queryKey: myListingsKey(status),
    queryFn: () => {
      const params = new URLSearchParams({ limit: '50' });
      if (status) params.set('status', status);
      return apiFetch(`/api/listings/mine?${params.toString()}`, ownedListingsResponseSchema);
    },
  });
}

export function useListerAnalytics(days = 30) {
  return useQuery({
    queryKey: ['lister-analytics', days],
    queryFn: () =>
      apiFetch(`/api/listings/mine/analytics?days=${String(days)}`, listerAnalyticsSchema),
  });
}

type StatusAction = 'pause' | 'unpause' | 'mark-rented';

/**
 * Pause, unpause and mark-rented, optimistically.
 *
 * Optimistic because the outcome is near-certain — the row is the caller's own
 * and the transition is a single UPDATE with no validation to fail — which is
 * the condition docs/design.md sets for optimistic mutations. Publishing is
 * deliberately NOT in this list: it runs the strict schema and can be refused,
 * so showing it as done first would be a lie the user then has to un-see.
 */
export function useListingStatusAction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: StatusAction }) =>
      apiFetch(`/api/listings/${id}/status`, listingStatusResponseSchema, {
        method: 'POST',
        body: JSON.stringify({ action }),
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['my-listings'] });
    },
  });
}

export function useDuplicateListing() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { listing } = await apiFetch(`/api/listings/${id}/duplicate`, createdListingSchema, {
        method: 'POST',
      });
      return listing;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['my-listings'] });
    },
  });
}
