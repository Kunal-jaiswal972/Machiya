import { coverageSetSchema, type CoveredCity, type CoverageRequestInput } from '@machiya/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { apiFetch } from '../lib/api';
import { requestCoverage } from '../lib/coverage';

/**
 * The cities the product covers, read from the API rather than written down.
 *
 * This is what makes correction 8's "adding a city is one record" claim true of
 * the frontend as well: the served set, the initial camera and the map's
 * `maxBounds` all come from `GET /api/coverage`, so a fourth city widens all
 * three with no code change here. Three hardcoded slugs would have made the
 * claim false in exactly the place a user would notice.
 *
 * `staleTime: Infinity` because the payload changes only when the OSM artifacts
 * are rebuilt, and the endpoint is cached hard server-side for the same reason.
 */
export interface CoverageState {
  cities: CoveredCity[];
  /** Bounding rectangle of every padded bbox, as maplibre wants it. */
  maxBounds: [number, number, number, number] | undefined;
  epoch: string | undefined;
  isLoading: boolean;
}

export function useCoverage(): CoverageState {
  const query = useQuery({
    queryKey: ['coverage'],
    queryFn: () => apiFetch('/api/coverage', coverageSetSchema),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const maxBounds = useMemo<[number, number, number, number] | undefined>(() => {
    const bounds = query.data?.maxBounds;
    if (!bounds) return undefined;
    return [bounds.minLng, bounds.minLat, bounds.maxLng, bounds.maxLat];
  }, [query.data?.maxBounds]);

  return {
    cities: query.data?.cities ?? [],
    maxBounds,
    epoch: query.data?.epoch,
    isLoading: query.isPending,
  };
}

/**
 * The covered city nearest a point, by straight-line distance to its centroid.
 *
 * Used for the initial camera, so a first-time visitor opens on the city they
 * are actually near rather than on whichever one happens to be first in the
 * list. Haversine here rather than a round trip: the answer only has to pick
 * between cities hundreds of kilometres apart, and blocking the first paint on
 * a request to rank three centroids would be absurd.
 */
export function nearestCoveredCity(
  cities: readonly CoveredCity[],
  point: { lat: number; lng: number },
): CoveredCity | undefined {
  let best: { city: CoveredCity; distance: number } | undefined;

  for (const city of cities) {
    const distance = haversineKm(point, city.centroid);
    if (!best || distance < best.distance) best = { city, distance };
  }

  return best?.city;
}

const EARTH_RADIUS_KM = 6371;

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * "Tell me when you cover Mumbai."
 *
 * Kept beside `useCoverage` rather than inside the notice component, because
 * the component's job is the designed state and this is a network write — and
 * because the two are the read and the write of the same concept.
 *
 * No retry: the two failure modes are a 409 for a point already covered and a
 * 429 from the hourly rate limit, and repeating either is pointless.
 */
export interface CoverageRequestState {
  submit: (input: CoverageRequestInput) => void;
  /** How many people have asked about somewhere near that point. */
  requests: number | null;
  isSaving: boolean;
  error: Error | null;
}

export function useCoverageRequest(): CoverageRequestState {
  const mutation = useMutation({
    mutationFn: (input: CoverageRequestInput) => requestCoverage(input),
    retry: false,
  });

  return {
    submit: mutation.mutate,
    requests: mutation.data?.requests ?? null,
    isSaving: mutation.isPending,
    error: mutation.error,
  };
}
