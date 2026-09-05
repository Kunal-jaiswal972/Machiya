import {
  commutePreferencesSchema,
  commuteComparisonSchema,
  commuteCostSchema,
  fuelSnapshotSchema,
  monthlyOutlaySchema,
  type CommutePreferences,
  type CommutePreferencesPatch,
} from '@machiya/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth-context';

const listingCommuteSchema = z.object({
  selected: commuteCostSchema,
  comparison: commuteComparisonSchema,
  outlay: monthlyOutlaySchema,
  preferences: commutePreferencesSchema,
  fuel: fuelSnapshotSchema.nullable(),
  degraded: z.boolean(),
});

export type ListingCommute = z.infer<typeof listingCommuteSchema>;

/**
 * Commute cost for one listing from the current office.
 *
 * Its own query rather than part of the listing fetch, for the same reason the
 * route and the POIs are: it depends on OSRM and on a scraped fuel price, and
 * neither may hold up the rent appearing on screen.
 */
export function useListingCommute(input: {
  slug: string;
  office: { lat: number; lng: number } | null;
}) {
  const query = useQuery({
    queryKey: ['commute', input.slug, input.office?.lat, input.office?.lng],
    enabled: input.office !== null,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        fromLat: String(input.office?.lat ?? 0),
        fromLng: String(input.office?.lng ?? 0),
      });
      return apiFetch(
        `/api/listings/${input.slug}/commute?${params.toString()}`,
        listingCommuteSchema,
        { signal },
      );
    },
    // The fuel price behind it has a one-hour TTL server-side; re-asking within
    // a session would move the number for no reason.
    staleTime: 5 * 60_000,
  });

  return {
    commute: query.data ?? null,
    isLoading: input.office !== null && query.isPending,
    error: query.error,
  };
}

const preferencesResponseSchema = z.object({ preferences: commutePreferencesSchema });

/**
 * The commute settings, and the optimistic write behind the panel's controls.
 *
 * Optimistic because the outcome is near-certain — it is a small validated
 * patch to the caller's own row — and because the whole point of the panel is
 * that moving a control moves the number. A round trip between the two would
 * make the relationship feel indirect.
 *
 * Signed out, the defaults are used and nothing is persisted. That is stated in
 * the panel rather than silently dropping the change.
 */
export function useCommutePreferences() {
  const { isSignedIn } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['commute-preferences'],
    enabled: isSignedIn,
    queryFn: () => apiFetch('/api/me/commute', preferencesResponseSchema),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const mutation = useMutation({
    mutationFn: (patch: CommutePreferencesPatch) =>
      apiFetch('/api/me/commute', preferencesResponseSchema, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: ['commute-preferences'] });
      const previous = queryClient.getQueryData(['commute-preferences']);

      queryClient.setQueryData(
        ['commute-preferences'],
        (current: { preferences: CommutePreferences } | undefined) =>
          current ? { preferences: { ...current.preferences, ...patch } } : current,
      );

      return { previous };
    },
    onError: (_error, _patch, context) => {
      // Put the old value back rather than leaving a number the server rejected.
      if (context?.previous) {
        queryClient.setQueryData(['commute-preferences'], context.previous);
      }
    },
    onSettled: () => {
      // Every commute figure on screen was computed from these settings.
      void queryClient.invalidateQueries({ queryKey: ['commute-preferences'] });
      void queryClient.invalidateQueries({ queryKey: ['commute'] });
      void queryClient.invalidateQueries({ queryKey: ['listings', 'search'] });
    },
  });

  return {
    preferences: query.data?.preferences ?? commutePreferencesSchema.parse({}),
    /** False when signed out: the controls still work, nothing is saved. */
    isPersisted: isSignedIn,
    update: mutation.mutate,
    isSaving: mutation.isPending,
  };
}
