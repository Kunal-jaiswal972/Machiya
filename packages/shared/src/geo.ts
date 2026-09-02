import { z } from 'zod';
import { MAX_SEARCH_RADIUS_METERS, RING_RADII_METERS } from './constants.js';

export const latitudeSchema = z.number().min(-90).max(90);
export const longitudeSchema = z.number().min(-180).max(180);

export const coordinateSchema = z.object({
  lat: latitudeSchema,
  lng: longitudeSchema,
});

export type Coordinate = z.infer<typeof coordinateSchema>;

/** 1 = inside 1 km, 2 = 1-2 km, 3 = 2-3 km. Computed server-side. */
export const ringSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type Ring = z.infer<typeof ringSchema>;

export const radiusMetersSchema = z.coerce
  .number()
  .int()
  .min(100)
  .max(MAX_SEARCH_RADIUS_METERS)
  .default(MAX_SEARCH_RADIUS_METERS);

export const cityBboxSchema = z.object({
  minLng: longitudeSchema,
  minLat: latitudeSchema,
  maxLng: longitudeSchema,
  maxLat: latitudeSchema,
});

export type CityBbox = z.infer<typeof cityBboxSchema>;

export const transitFareConfigSchema = z.object({
  currency: z.string().default('INR'),
  /** Flat boarding fare, in whole rupees. */
  baseFare: z.number().nonnegative(),
  /** Marginal cost per kilometre, in whole rupees. */
  perKm: z.number().nonnegative(),
  /** Fare is never lower than this, in whole rupees. */
  minFare: z.number().nonnegative().default(0),
  notes: z.string().optional(),
});

export type TransitFareConfig = z.infer<typeof transitFareConfigSchema>;

/**
 * Which ring a straight-line or road distance falls in.
 *
 * Anything beyond the outermost ring returns undefined rather than clamping — a
 * caller asking about a point outside the search radius has a bug, and silently
 * calling it ring 3 would hide it.
 */
export function ringForDistance(distanceMeters: number): Ring | undefined {
  const index = RING_RADII_METERS.findIndex((radius) => distanceMeters <= radius);
  if (index === -1) return undefined;
  return (index + 1) as Ring;
}
