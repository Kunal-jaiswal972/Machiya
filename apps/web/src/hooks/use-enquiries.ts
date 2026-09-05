import {
  enquiryDetailResponseSchema,
  enquiryListResponseSchema,
  type EnquiryMessageInput,
} from '@machiya/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '../lib/api';

export const enquiriesKey = (role?: 'seeker' | 'lister') => ['enquiries', role ?? 'all'] as const;
export const enquiryKey = (id: string | undefined) => ['enquiry', id] as const;

export function useEnquiries(role?: 'seeker' | 'lister') {
  return useQuery({
    queryKey: enquiriesKey(role),
    queryFn: () =>
      apiFetch(`/api/enquiries${role ? `?role=${role}` : ''}`, enquiryListResponseSchema),
    // A thread the other party has replied to should appear without a reload,
    // and this is the one screen where a person is actually waiting on someone.
    refetchInterval: 30_000,
  });
}

export function useEnquiry(id: string | undefined) {
  return useQuery({
    queryKey: enquiryKey(id),
    queryFn: () => apiFetch(`/api/enquiries/${id!}`, enquiryDetailResponseSchema),
    enabled: Boolean(id),
    refetchInterval: 15_000,
  });
}

const messageCreatedSchema = z.object({ message: z.object({ id: z.string() }) });
const enquiryCreatedSchema = z.object({ enquiryId: z.string() });
const readSchema = z.object({ read: z.number().int() });

export function useSendMessage(enquiryId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: EnquiryMessageInput) =>
      apiFetch(`/api/enquiries/${enquiryId!}/messages`, messageCreatedSchema, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: enquiryKey(enquiryId) });
      void queryClient.invalidateQueries({ queryKey: ['enquiries'] });
    },
  });
}

/** Opens a thread from the listing page, or appends to the existing one. */
export function useStartEnquiry(listingSlug: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: EnquiryMessageInput) =>
      apiFetch(`/api/listings/${listingSlug}/enquiries`, enquiryCreatedSchema, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['enquiries'] });
      // The owner's number is unmasked by the existence of this thread, so the
      // listing has to be re-read for it to appear.
      void queryClient.invalidateQueries({ queryKey: ['listing', listingSlug] });
    },
  });
}

export function useMarkEnquiryRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (enquiryId: string) =>
      apiFetch(`/api/enquiries/${enquiryId}/read`, readSchema, { method: 'POST' }),
    onSuccess: (_result, enquiryId) => {
      void queryClient.invalidateQueries({ queryKey: enquiryKey(enquiryId) });
      void queryClient.invalidateQueries({ queryKey: ['enquiries'] });
    },
  });
}
