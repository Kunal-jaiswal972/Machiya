import { profileUpdateSchema, sessionUserSchema, type ProfileUpdateInput } from '@machiya/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth-context';

const meSchema = z.object({ user: sessionUserSchema });

/**
 * The account as the server holds it.
 *
 * The session already carries name and email, but not phone — it is declared
 * `input: false` on the auth side so a sign-up payload cannot set it — so the
 * account page reads the row rather than the session.
 */
export function useProfile() {
  const { isSignedIn } = useAuth();

  return useQuery({
    queryKey: ['me'],
    enabled: isSignedIn,
    queryFn: () => apiFetch('/api/me', meSchema),
    staleTime: 60_000,
  });
}

export function useUpdateProfile() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (input: ProfileUpdateInput) =>
      apiFetch('/api/me', meSchema, {
        method: 'PATCH',
        body: JSON.stringify(profileUpdateSchema.parse(input)),
      }),
    onSuccess: (result) => {
      client.setQueryData(['me'], result);
    },
  });
}

/**
 * Deleting the account. Not optimistic, and deliberately so: this is the one
 * mutation where showing the outcome before the server has agreed would be
 * showing someone their account is gone when it may not be.
 */
export function useDeleteAccount() {
  return useMutation({
    mutationFn: () =>
      apiFetch('/api/me', z.object({ deletedAt: z.string() }), { method: 'DELETE' }),
  });
}
