import {
  listingCardListSchema,
  poiLookupResultSchema,
  routeResultSchema,
  type Coordinate,
  type RouteProfile,
} from '@machiya/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '../lib/api';
import { listingDetailSchema } from '../lib/listing-schemas';

/**
 * The detail view's reads. Four separate queries on purpose: they have
 * different failure modes and different latencies, and the listing must render
 * without waiting for any of the other three.
 */
export function useListingDetail(slug: string) {
  return useQuery({
    queryKey: ['listing', slug],
    queryFn: () => apiFetch(`/api/listings/${slug}`, listingDetailSchema),
    staleTime: 60_000,
  });
}

const routeResponseSchema = z.object({ route: routeResultSchema });

export function useListingRoute(input: {
  slug: string;
  from: Coordinate | null;
  profile: RouteProfile;
}) {
  const { slug, from, profile } = input;

  return useQuery({
    queryKey: ['listing', slug, 'route', profile, from?.lat ?? null, from?.lng ?? null],
    enabled: from !== null,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        fromLat: String(from?.lat ?? 0),
        fromLng: String(from?.lng ?? 0),
        profile,
      });
      return apiFetch(`/api/listings/${slug}/route?${params.toString()}`, routeResponseSchema, {
        signal,
      });
    },
    // Cached 24h on the server; a route between two fixed points does not move.
    staleTime: 10 * 60_000,
  });
}

/**
 * Nearby places.
 *
 * Against the self-hosted Overpass (D48) a cold read normally just returns the
 * answer. But the server bounds how long it waits: if the geo profile is
 * importing or down it answers `degraded: true` with an empty list rather than
 * holding the request open. So this refetches while the answer is degraded and
 * empty, and stops the moment real data arrives.
 */
export function useListingPois(slug: string) {
  return useQuery({
    queryKey: ['listing', slug, 'pois'],
    queryFn: ({ signal }) =>
      apiFetch(`/api/listings/${slug}/pois`, poiLookupResultSchema, { signal }),
    staleTime: 10 * 60_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      // Still warming, which now means the local Overpass is importing or
      // down. Poll gently: a tighter interval would just queue requests
      // behind a service that is not ready.
      return data.degraded && data.pois.length === 0 ? 8_000 : false;
    },
  });
}

export function useSimilarListings(slug: string) {
  return useQuery({
    queryKey: ['listing', slug, 'similar'],
    queryFn: () => apiFetch(`/api/listings/${slug}/similar`, listingCardListSchema),
    staleTime: 5 * 60_000,
  });
}

/**
 * The view ping.
 *
 * Fired once per mount and deliberately ignored: the server deduplicates by
 * viewer and window, so a failure here changes nothing the user can see and
 * must never surface as an error.
 */
export function useRecordView() {
  return useMutation({
    mutationFn: (slug: string) =>
      apiFetch(`/api/listings/${slug}/view`, z.object({ ok: z.boolean() }), { method: 'POST' }),
    // Telemetry. A retry would only inflate the queue behind a dedupe key.
    retry: false,
  });
}
