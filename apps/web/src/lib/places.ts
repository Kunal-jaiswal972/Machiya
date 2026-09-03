import {
  geocodeResultSchema,
  placeSuggestionsSchema,
  type Coordinate,
  type GeocodeResult,
  type PlaceSuggestions,
} from '@machiya/shared';
import { z } from 'zod';
import { apiFetch } from './api';

const reverseResponseSchema = z.object({ place: geocodeResultSchema.nullable() });

export async function fetchPlaceSuggestions(
  input: { query: string; citySlug?: string; limit?: number },
  signal?: AbortSignal,
): Promise<PlaceSuggestions> {
  const params = new URLSearchParams({ q: input.query });
  if (input.citySlug) params.set('citySlug', input.citySlug);
  if (input.limit) params.set('limit', String(input.limit));

  return apiFetch(`/api/places/suggest?${params.toString()}`, placeSuggestionsSchema, { signal });
}

export async function reverseGeocode(
  coordinate: Coordinate,
  signal?: AbortSignal,
): Promise<GeocodeResult | null> {
  const params = new URLSearchParams({
    lat: coordinate.lat.toFixed(6),
    lng: coordinate.lng.toFixed(6),
  });

  const { place } = await apiFetch(
    `/api/places/reverse?${params.toString()}`,
    reverseResponseSchema,
    { signal },
  );

  return place;
}

/**
 * What to call an office the reverse geocoder could not name.
 *
 * A dropped pin over an unmapped field is a legitimate office location — a new
 * campus on the edge of town is exactly that — so the UI shows coordinates
 * rather than refusing the selection or saying "not found".
 */
export function describeCoordinate(coordinate: Coordinate): string {
  return `${coordinate.lat.toFixed(4)}, ${coordinate.lng.toFixed(4)}`;
}
