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

/**
 * How quiet a thread must go before a new message earns another email.
 *
 * "First message in the thread" and "first message in a while" are different
 * rules, and the second is the one people expect: a burst of replies inside one
 * conversation should be one notification, and a thread that resumes a week
 * later should be a new one. Twenty-four hours is the boundary between "they
 * are still in this conversation" and "they have moved on and need telling".
 * See DECISIONS.md D68.
 */
export const ENQUIRY_NOTIFY_QUIET_HOURS = 24;

/** After this many failed sends the message stops being owed a mail. */
export const ENQUIRY_NOTIFY_MAX_ATTEMPTS = 5;

/** The reconciler ignores anything younger than this, to avoid racing the enqueue. */
export const ENQUIRY_NOTIFY_GRACE_MINUTES = 2;
