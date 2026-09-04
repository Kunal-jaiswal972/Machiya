import {
  placeSuggestionsSchema,
  reversePlaceResponseSchema,
  type Coordinate,
  type PlaceSuggestions,
  type ReversePlaceResponse,
} from '@machiya/shared';
import { apiFetch } from './api';

export async function fetchPlaceSuggestions(
  input: { query: string; citySlug?: string; limit?: number },
  signal?: AbortSignal,
): Promise<PlaceSuggestions> {
  const params = new URLSearchParams({ q: input.query });
  if (input.citySlug) params.set('citySlug', input.citySlug);
  if (input.limit) params.set('limit', String(input.limit));

  return apiFetch(`/api/places/suggest?${params.toString()}`, placeSuggestionsSchema, { signal });
}

/**
 * Name a point.
 *
 * Returns the envelope rather than the place, because a null place means two
 * different things: no address at a legitimate coordinate, or a coordinate the
 * product does not reach. The second carries `coverage`. See
 * `reversePlaceResponseSchema`.
 */
export async function reverseGeocode(
  coordinate: Coordinate,
  signal?: AbortSignal,
): Promise<ReversePlaceResponse> {
  const params = new URLSearchParams({
    lat: coordinate.lat.toFixed(6),
    lng: coordinate.lng.toFixed(6),
  });

  return apiFetch(`/api/places/reverse?${params.toString()}`, reversePlaceResponseSchema, {
    signal,
  });
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
