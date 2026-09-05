import {
  adminUsersResponseSchema,
  coverageDemandSchema,
  moderationQueueResponseSchema,
} from '@machiya/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '../lib/api';
import { authClient } from '../lib/auth-client';

export function useModerationQueue() {
  return useQuery({
    queryKey: ['admin', 'moderation'],
    queryFn: async () =>
      (await apiFetch('/api/admin/moderation', moderationQueueResponseSchema)).listings,
  });
}

const verifiedSchema = z.object({ id: z.string(), isVerified: z.boolean() });

export function useVerifyListing() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, isVerified }: { id: string; isVerified: boolean }) =>
      apiFetch(`/api/admin/listings/${id}/verify`, verifiedSchema, {
        method: 'POST',
        body: JSON.stringify({ isVerified }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'moderation'] });
    },
  });
}

export function useAdminUsers(query: string) {
  return useQuery({
    queryKey: ['admin', 'users', query],
    queryFn: async () =>
      (
        await apiFetch(
          `/api/admin/users${query ? `?q=${encodeURIComponent(query)}` : ''}`,
          adminUsersResponseSchema,
        )
      ).users,
  });
}

export function useCoverageDemand() {
  return useQuery({
    queryKey: ['admin', 'coverage-demand'],
    queryFn: () => apiFetch('/api/admin/coverage-demand', coverageDemandSchema),
  });
}

/**
 * Ban, unban and role changes go through Better Auth's own admin plugin, not
 * through our API.
 *
 * The plugin owns session revocation, and a role change that did not revoke the
 * existing session would leave a demoted admin holding admin rights until their
 * cookie expired. Reimplementing that against the Session table would be a
 * second source of truth for the thing least safe to have two of.
 */
export function useAdminUserActions() {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
  };

  const ban = useMutation({
    mutationFn: ({ userId, reason }: { userId: string; reason: string }) =>
      authClient.admin.banUser({ userId, banReason: reason }),
    onSuccess: refresh,
  });

  const unban = useMutation({
    mutationFn: (userId: string) => authClient.admin.unbanUser({ userId }),
    onSuccess: refresh,
  });

  const setRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: 'SEEKER' | 'LISTER' | 'ADMIN' }) =>
      authClient.admin.setRole({ userId, role }),
    onSuccess: refresh,
  });

  return { ban, unban, setRole };
}
