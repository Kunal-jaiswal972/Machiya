import { prisma, straightLineDistanceMeters } from '@machiya/db';
import {
  commutePreferencesSchema,
  compareCommuteModes,
  reconcileCommutePreferences,
  computeCommuteCost,
  computeMonthlyOutlay,
  effectiveMileage,
  routeProfileForMode,
  vehicleClass,
  type CommuteComparison,
  type CommuteParamsQuery,
  type CommutePreferences,
  type CommutePreferencesPatch,
  type Coordinate,
  type FuelSnapshot,
  type MonthlyOutlay,
} from '@machiya/shared';
import { cityBySlug } from '@machiya/shared/cities';
import { estimateRoute, resolveRoutingProvider } from '../geo/osrm.js';
import { logger } from '../logger.js';
import { HttpError } from '../middleware/error-handler.js';
import type { RequestSession } from '../middleware/require-auth.js';
import { assertCovered } from './coverage.js';
import { getFuelPrice } from './fuel.js';

/**
 * Commute cost for one listing from one office — the number the product is
 * built to argue with.
 *
 * The arithmetic is in `@machiya/shared/commute` and is pure. This module does
 * the impure half: real road distance from OSRM, a real fuel price from the
 * scrapers, the city's transit fares, and the user's own settings.
 */

// --- preferences ------------------------------------------------------------

/**
 * The user's settings, or the defaults when they have never touched them.
 *
 * Parsed rather than cast on the way out. The column is JSON, so a blob written
 * by an older shape is a real possibility, and a missing `mileageKmPerLitre`
 * would otherwise reach the engine as `undefined` and produce `NaN` rupees —
 * a number that renders, which is the worst kind of wrong.
 */
export async function getCommutePreferences(userId: string): Promise<CommutePreferences> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { commutePrefs: true },
  });

  const parsed = commutePreferencesSchema.safeParse(user?.commutePrefs ?? {});

  if (!parsed.success) {
    logger.warn(
      { userId, issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
      'stored commute preferences do not match the current shape; using defaults',
    );
    return commutePreferencesSchema.parse({});
  }

  return parsed.data;
}

/**
 * Merges a patch into the stored settings.
 *
 * Read-modify-write rather than a JSON merge in SQL, because the merged result
 * has to be **validated as a whole**: `mode: 'bike'` with a car's mileage is
 * two individually valid fields and one nonsensical setting.
 */
export async function updateCommutePreferences(
  session: RequestSession,
  patch: CommutePreferencesPatch,
): Promise<CommutePreferences> {
  const current = await getCommutePreferences(session.userId);
  const merged = commutePreferencesSchema.parse({ ...current, ...patch });

  // Changing vehicle class clears a pinned mileage unless the same patch set
  // one. Otherwise picking "SUV" would silently keep the hatchback's 15 km/l
  // and quietly understate the commute — the error this product must not make.
  if (
    patch.vehicleClass &&
    patch.vehicleClass !== current.vehicleClass &&
    !patch.mileageKmPerLitre
  ) {
    merged.mileageKmPerLitre = null;
  }

  await prisma.user.update({
    where: { id: session.userId },
    data: { commutePrefs: merged },
  });

  return merged;
}

// --- the commute itself -----------------------------------------------------

export interface ListingCommute {
  /** The mode the user's settings selected, priced in full. */
  selected: ReturnType<typeof computeCommuteCost>;
  /** All three modes, for the comparison bars. */
  comparison: CommuteComparison;
  outlay: MonthlyOutlay;
  preferences: CommutePreferences;
  /** Where the fuel price came from, and how fresh it is. */
  fuel: FuelSnapshot | null;
  /**
   * True when a road distance could not be measured and a straight-line
   * estimate stands in. The UI labels it rather than presenting an estimate as
   * measured fact — the whole argument depends on not doing that.
   */
  degraded: boolean;
}

/**
 * Road distance for one profile, or a labelled estimate.
 *
 * Both distance AND duration come from the same route, because a comparison
 * that mixed a measured distance with a guessed duration would be worse than
 * one that guessed both and said so.
 */
async function legFor(
  from: Coordinate,
  to: Coordinate,
  profile: 'car' | 'bike',
  signal?: AbortSignal,
): Promise<{ distanceMeters: number; durationSeconds: number; degraded: boolean }> {
  const route = await resolveRoutingProvider().route({
    from,
    to,
    profile,
    ...(signal ? { signal } : {}),
  });

  if (route) {
    return {
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      degraded: route.degraded,
    };
  }

  const straightLine = await straightLineDistanceMeters(from, to);
  const estimate = estimateRoute({ straightLineMeters: straightLine, profile });

  return {
    distanceMeters: estimate.distanceMeters,
    durationSeconds: estimate.durationSeconds,
    degraded: true,
  };
}

export async function getListingCommute(input: {
  slug: string;
  from: Coordinate;
  session?: RequestSession | undefined;
  /**
   * Settings supplied by the caller, which win over the stored ones.
   *
   * This is what makes the answer a function of the request rather than of
   * ambient session state — so it can be cached by URL, and so a signed-out
   * visitor's own choices produce real numbers. It is also the per-listing
   * override: sending them does not touch the stored preference. See D76.
   */
  overrides?: CommuteParamsQuery | undefined;
  signal?: AbortSignal;
}): Promise<ListingCommute> {
  const listing = await prisma.listing.findUnique({
    where: { slug: input.slug },
    select: {
      lat: true,
      lng: true,
      status: true,
      rentAmount: true,
      maintenanceMonthly: true,
      city: { select: { slug: true } },
    },
  });

  if (!listing || listing.status !== 'PUBLISHED') {
    throw new HttpError(404, 'listing_not_found', 'No such listing');
  }

  // The office is a coordinate the caller chose and may be outside coverage,
  // where OSRM answers 400 and the estimate would be a plausible number for a
  // commute nobody could make. Refused here rather than downstream (D53).
  await assertCovered(input.from);

  const stored = input.session
    ? await getCommutePreferences(input.session.userId)
    : commutePreferencesSchema.parse({});

  // Reconciled after merging, not before: an override may name a mode without
  // naming a vehicle, and "bike with the stored sedan" is the combination that
  // priced a bike ride on a car (D63, docs/ux-audit.md 1.3).
  const preferences = reconcileCommutePreferences(
    commutePreferencesSchema.parse({
      ...stored,
      ...Object.fromEntries(
        Object.entries(input.overrides ?? {}).filter(([, value]) => value !== undefined),
      ),
    }),
  );

  const to: Coordinate = { lat: listing.lat, lng: listing.lng };
  const citySlug = listing.city.slug;

  // Both graphs, because the bike figure has to be priced on the bike's own
  // distance — measured 9.82 km by car against 10.33 km by bike for one real
  // pair. In parallel: they are two independent services.
  const [car, bike] = await Promise.all([
    legFor(input.from, to, 'car', input.signal),
    legFor(input.from, to, 'bike', input.signal),
  ]);

  const fuel = await getFuelPrice(citySlug, preferences.fuelType);
  const fuelPricePerLitre = fuel?.price ?? 0;

  if (!fuel) {
    logger.warn(
      { citySlug, fuelType: preferences.fuelType },
      'no fuel price available; commute cost will show fuel modes as zero',
    );
  }

  const city = cityBySlug(citySlug);
  const mileage = effectiveMileage(preferences);
  const bikeMileage =
    preferences.mode === 'bike' ? mileage : vehicleClass('scooter').mileageKmPerLitre;

  const comparison = compareCommuteModes({
    car: { distanceMeters: car.distanceMeters, durationSeconds: car.durationSeconds },
    bike: { distanceMeters: bike.distanceMeters, durationSeconds: bike.durationSeconds },
    fuelType: fuel?.fuelType ?? preferences.fuelType,
    fuelPricePerLitre,
    // The car figure uses the user's class only when they drive; otherwise a
    // sensible hatchback, so the comparison bar means something to a cyclist.
    mileageKmPerLitre:
      preferences.mode === 'bike' ? vehicleClass('hatchback').mileageKmPerLitre : mileage,
    bikeMileageKmPerLitre: bikeMileage,
    tripsPerDay: preferences.tripsPerDay,
    workingDaysPerMonth: preferences.workingDaysPerMonth,
    transitFare: city.transitFare,
  });

  const selectedProfile = routeProfileForMode(preferences.mode);
  const leg = selectedProfile === 'bike' ? bike : car;

  const selected = computeCommuteCost({
    mode: preferences.mode,
    roadDistanceMeters: leg.distanceMeters,
    roadDurationSeconds: leg.durationSeconds,
    fuelType: fuel?.fuelType ?? preferences.fuelType,
    fuelPricePerLitre,
    mileageKmPerLitre: preferences.mode === 'bike' ? bikeMileage : mileage,
    tripsPerDay: preferences.tripsPerDay,
    workingDaysPerMonth: preferences.workingDaysPerMonth,
    transitFare: city.transitFare,
  });

  return {
    selected,
    comparison,
    outlay: computeMonthlyOutlay({
      rent: listing.rentAmount,
      maintenanceMonthly: listing.maintenanceMonthly,
      commuteMonthly: selected.perMonth,
    }),
    preferences,
    fuel: fuel?.snapshot ?? null,
    degraded: leg.degraded,
  };
}
