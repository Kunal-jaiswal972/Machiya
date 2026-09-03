import { cityBboxSchema, fuelTypeSchema, transitFareConfigSchema } from '@machiya/shared';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '../lib/api';

const citySchema = z.object({
  slug: z.string(),
  name: z.string(),
  state: z.string(),
  centroidLat: z.number(),
  centroidLng: z.number(),
  bbox: cityBboxSchema,
  defaultFuelType: fuelTypeSchema,
  transitFareConfig: transitFareConfigSchema.nullable(),
  listingCount: z.number().int(),
});

export type City = z.infer<typeof citySchema>;

const citiesResponseSchema = z.object({ cities: z.array(citySchema) });

/**
 * The three cities the product covers.
 *
 * Effectively static — they change when someone edits `scripts/cities.ts` and
 * re-seeds — so this is cached hard on both sides. `staleTime: Infinity` means
 * one fetch per page load rather than one per component that asks.
 */
export function useCities() {
  const query = useQuery({
    queryKey: ['cities'],
    queryFn: () => apiFetch('/api/cities', citiesResponseSchema),
    staleTime: Number.POSITIVE_INFINITY,
  });

  return { cities: query.data?.cities ?? [], isLoading: query.isPending };
}
