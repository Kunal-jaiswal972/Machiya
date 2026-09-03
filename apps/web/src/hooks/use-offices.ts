import { officeListSchema, type Office, type OfficeInput } from '@machiya/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch, ApiRequestError } from '../lib/api';
import { useAuth } from '../lib/auth-context';

const officeResponseSchema = z.object({
  office: officeListSchema.shape.offices.element,
});

const OFFICES_KEY = ['offices'] as const;

/**
 * Saved offices for the signed-in user.
 *
 * Disabled when nobody is signed in — an anonymous visitor gets the office
 * field and the map, and prompting them to sign in before they have seen a
 * single listing is the wrong order.
 */
export function useOffices() {
  const { user } = useAuth();

  const query = useQuery({
    queryKey: OFFICES_KEY,
    enabled: Boolean(user),
    queryFn: () => apiFetch('/api/offices', officeListSchema),
    staleTime: 5 * 60_000,
  });

  return {
    offices: query.data?.offices ?? [],
    defaultOffice: query.data?.offices.find((office) => office.isDefault) ?? null,
    isLoading: Boolean(user) && query.isPending,
  };
}

export function useSaveOffice() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: OfficeInput) =>
      apiFetch('/api/offices', officeResponseSchema, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: OFFICES_KEY });
    },
  });
}

export function useDeleteOffice() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (officeId: string) =>
      apiFetch(`/api/offices/${officeId}`, z.object({ id: z.string() }), { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: OFFICES_KEY });
    },
  });
}

export function useSetDefaultOffice() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (officeId: string) =>
      apiFetch(`/api/offices/${officeId}`, officeResponseSchema, {
        method: 'PATCH',
        body: JSON.stringify({ isDefault: true }),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: OFFICES_KEY });
    },
  });
}

/** True when the failure was "not signed in", which is not an error to show. */
export function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 401;
}

export type { Office };
