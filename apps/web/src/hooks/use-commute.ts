import {
  commutePreferencesSchema,
  commutePreferencesToQuery,
  commuteComparisonSchema,
  commuteCostSchema,
  fuelSnapshotSchema,
  monthlyOutlaySchema,
  type CommutePreferences,
  type CommutePreferencesPatch,
} from '@machiya/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { z } from 'zod';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth-context';
import { useCommutePreferencesStore } from '../stores/commute-preferences';

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
  const preferences = useCommutePreferencesStore((state) => state.preferences);
  const commuteQuery = commutePreferencesToQuery(preferences);

  const query = useQuery({
    // The settings are part of the key because they are part of the answer.
    // Keyed only on slug and office, a change to mileage left a cached entry
    // that no invalidation could correct — and the URL was identical, so the
    // browser's own cache returned the old numbers too (docs/ux-audit.md 1.1).
    queryKey: ['commute', input.slug, input.office?.lat, input.office?.lng, commuteQuery],
    enabled: input.office !== null,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        fromLat: String(input.office?.lat ?? 0),
        fromLng: String(input.office?.lng ?? 0),
        ...commuteQuery,
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
  const preferences = useCommutePreferencesStore((state) => state.preferences);
  const hydrated = useCommutePreferencesStore((state) => state.hydratedFromServer);
  const apply = useCommutePreferencesStore((state) => state.apply);
  const adopt = useCommutePreferencesStore((state) => state.adopt);

  const query = useQuery({
    queryKey: ['commute-preferences'],
    enabled: isSignedIn,
    queryFn: () => apiFetch('/api/me/commute', preferencesResponseSchema),
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Fold the stored settings in once, so a signed-in user sees their own rather
  // than whatever this browser last used. After that the store leads and the
  // server follows — a refetch must not clobber a change in flight.
  const serverPreferences = query.data?.preferences;
  useEffect(() => {
    if (!isSignedIn || hydrated || !serverPreferences) return;
    adopt(serverPreferences);
  }, [isSignedIn, hydrated, serverPreferences, adopt]);

  const mutation = useMutation({
    mutationFn: (next: CommutePreferences) =>
      apiFetch('/api/me/commute', preferencesResponseSchema, {
        method: 'PATCH',
        body: JSON.stringify(next),
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(['commute-preferences'], result);
    },
  });

  /**
   * Applies a change immediately, then persists it when there is somewhere to
   * persist to.
   *
   * The local write is not optimistic in the TanStack sense — it is the actual
   * state. Nothing on screen waits for the server, and nothing is rolled back
   * if the server is unreachable: the number the user is looking at came from
   * the settings they can see.
   */
  const update = (patch: CommutePreferencesPatch): void => {
    const next = apply(patch);
    if (isSignedIn) mutation.mutate(next);
  };

  return {
    preferences,
    /** False when signed out: the controls work, the choice lives on this device. */
    isPersisted: isSignedIn,
    update,
    isSaving: mutation.isPending,
  };
}
