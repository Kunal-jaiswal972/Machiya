/** Distance rings drawn around the office, in metres. */
export const RING_RADII_METERS = [1000, 2000, 3000] as const;

/** Outermost ring — the hard bound of every radius search. */
export const MAX_SEARCH_RADIUS_METERS = 3000;

/** Radius used when pulling nearby POIs for a listing, in metres. */
export const POI_RADIUS_METERS = 1500;

/** Redis TTLs, in seconds. */
export const CACHE_TTL_SECONDS = {
  poi: 60 * 60 * 24,
  route: 60 * 60 * 24,
  geocode: 60 * 60 * 24 * 7,
  fuelPrice: 60 * 60,
} as const;

/** Commute cost defaults, all overridable per user in the UI. */
export const COMMUTE_DEFAULTS = {
  tripsPerDay: 2,
  workingDaysPerMonth: 22,
  carMileageKmPerLitre: 15,
  bikeMileageKmPerLitre: 45,
} as const;

export type RingRadius = (typeof RING_RADII_METERS)[number];
