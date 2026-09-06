import type { ListingDraftView, ListingPatchInput } from '@machiya/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { ApiRequestError, apiFetch } from '../lib/api';
import {
  amenityGroupsResponseSchema,
  createdListingSchema,
  listingDraftResponseSchema,
  listingPatchedSchema,
  listingStatusResponseSchema,
} from '../lib/listing-schemas';

export type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

export const draftKey = (id: string | undefined) => ['listing-draft', id] as const;

export interface DraftStart {
  citySlug: string;
  lat: number;
  lng: number;
  address?: string | undefined;
  locality?: string | undefined;
}

/** Opens the draft row from the first accepted pin. */
export function useOpenDraft() {
  return useMutation({
    mutationFn: async (start: DraftStart) => {
      const { listing } = await apiFetch('/api/listings', createdListingSchema, {
        method: 'POST',
        body: JSON.stringify(start),
      });
      return listing;
    },
  });
}

/**
 * One draft, and the autosave that keeps it on the server.
 *
 * The client holds **nothing** that matters. Every step writes through to the
 * draft row, which is what lets someone close the tab on a laptop and finish
 * the listing on a phone — the requirement browser storage cannot meet, and the
 * reason the columns are nullable at all (DECISIONS.md D67).
 */
export interface FieldRejection {
  /** The field the server refused, as its own name for it. */
  field: string;
  message: string;
}

export function useListingDraft(id: string | undefined) {
  const queryClient = useQueryClient();
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [rejections, setRejections] = useState<FieldRejection[]>([]);

  const query = useQuery({
    queryKey: draftKey(id),
    queryFn: async () => {
      const { draft } = await apiFetch(`/api/listings/${id!}/draft`, listingDraftResponseSchema);
      return draft;
    },
    enabled: Boolean(id),
    // The wizard is the only writer, and every write already updates the cache.
    // Refetching on focus would fight a half-typed step.
    refetchOnWindowFocus: false,
  });

  /**
   * The write in flight, so a slow save cannot land after a newer one.
   *
   * Steps autosave on blur and on next, which is easily two writes inside one
   * round trip on a slow connection. Without the guard the older response
   * overwrites the newer cache entry and the user watches their last edit
   * disappear.
   */
  const pending = useRef(0);

  const mutation = useMutation({
    mutationFn: async (patch: ListingPatchInput) => {
      await apiFetch(`/api/listings/${id!}`, listingPatchedSchema, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      return patch;
    },
    onMutate: () => {
      pending.current += 1;
      setSaveState('saving');
      return { ticket: pending.current };
    },
    onSuccess: (patch, _variables, context) => {
      if (context.ticket !== pending.current) return;
      setSaveState('saved');
      queryClient.setQueryData<ListingDraftView>(draftKey(id), (previous) =>
        previous ? { ...previous, ...(patch as Partial<ListingDraftView>) } : previous,
      );
    },
    onError: (error) => {
      setSaveState('failed');
      // WHY the save failed, not just that it did. The server rejects a short
      // title or an area below the floor with a per-field message, and
      // dropping it left the wizard blaming the connection for a value the
      // person could fix in two seconds — then saying "Saved" on Next while
      // the value was never written (docs/ux-audit.md W-01).
      setRejections(
        error instanceof ApiRequestError && error.detail.issues
          ? error.detail.issues.map((issue) => ({ field: issue.path, message: issue.message }))
          : [],
      );
    },
  });

  const save = useCallback(
    (patch: ListingPatchInput) => {
      if (!id) return;
      setRejections([]);
      mutation.mutate(patch);
    },
    [id, mutation],
  );

  /**
   * Awaitable, for the Next button that must not advance through a failed
   * write. Resolves once the write lands and REJECTS when the server refuses.
   */
  const saveAsync = useCallback(
    async (patch: ListingPatchInput) => {
      if (!id) return;
      setRejections([]);
      await mutation.mutateAsync(patch);
    },
    [id, mutation],
  );

  return {
    draft: query.data,
    isLoading: query.isPending && Boolean(id),
    error: query.error,
    save,
    saveAsync,
    rejections,
    saveState,
    refetch: query.refetch,
  };
}

export function usePublishDraft(id: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiFetch(`/api/listings/${id!}/status`, listingStatusResponseSchema, {
        method: 'POST',
        body: JSON.stringify({ action: 'publish' }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: draftKey(id) });
      void queryClient.invalidateQueries({ queryKey: ['my-listings'] });
    },
  });
}

export function useAmenityGroups() {
  return useQuery({
    queryKey: ['amenities'],
    queryFn: async () => {
      const { groups } = await apiFetch('/api/amenities', amenityGroupsResponseSchema);
      return groups;
    },
    // Sixteen rows that change only when someone re-seeds; the endpoint is
    // cached server-side for the same reason.
    staleTime: 5 * 60 * 1000,
  });
}
