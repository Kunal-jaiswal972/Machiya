/**
 * The commute cost engine — the product's whole argument, as arithmetic.
 *
 * A cheaper flat 3 km out losing to a pricier one 800 m away is the inversion
 * this exists to surface, and it only surfaces if the numbers are honest. Two
 * rules govern everything here:
 *
 *  1. **Distance is real ROAD distance, from OSRM.** Never straight-line. A
 *     city with a river or a one-way system through it makes straight-line
 *     understate every commute, and a product that says "this is your real
 *     commute" cannot be doing that. `ST_Distance` is for ring arithmetic only.
 *  2. **Nothing here reads a clock, a network or a database.** Pure functions
 *     over declared inputs, so the same inputs give the same rupees on the
 *     server, in the browser and in a test.
 *
 * Fuel prices come from `@machiya/shared/fuel` via the scrapers; the road
 * distance comes from the routing provider. This module only spends them.
 */
import { z } from 'zod';
import { COMMUTE_DEFAULTS } from './constants.js';
import { fuelTypeSchema, type FuelType } from './enums.js';
import { transitFareConfigSchema, type TransitFareConfig } from './geo/schemas.js';

/**
 * How someone gets to work. Not the same set as `RouteProfile`: routing has two
 * graphs (car, bike) and costing has three modes, because transit is priced
 * from a fare table rather than from fuel — it still needs the road distance,
 * which is why it shares the car graph.
 */
export const commuteModeSchema = z.enum(['car', 'bike', 'transit']);

export type CommuteMode = z.infer<typeof commuteModeSchema>;

export const COMMUTE_MODES = commuteModeSchema.options;

/** Which routing graph a mode measures its distance on. */
export function routeProfileForMode(mode: CommuteMode): 'car' | 'bike' {
  return mode === 'bike' ? 'bike' : 'car';
}

/**
 * Mileage defaults per vehicle class, km per litre.
 *
 * Deliberately conservative for Indian city traffic — a hatchback rated 20
 * km/l on a highway does far worse in Bengaluru at 9am, and a cost engine that
 * flatters the commute argues against the product's own point. Every one is
 * overridable per user, which is the real answer to "is 15 right for my car".
 */
export const VEHICLE_CLASSES = [
  { id: 'hatchback', label: 'Hatchback', mode: 'car', mileageKmPerLitre: 15 },
  { id: 'sedan', label: 'Sedan', mode: 'car', mileageKmPerLitre: 13 },
  { id: 'suv', label: 'SUV', mode: 'car', mileageKmPerLitre: 10 },
  { id: 'scooter', label: 'Scooter', mode: 'bike', mileageKmPerLitre: 45 },
  { id: 'motorcycle', label: 'Motorcycle', mode: 'bike', mileageKmPerLitre: 50 },
] as const satisfies readonly {
  id: string;
  label: string;
  mode: CommuteMode;
  mileageKmPerLitre: number;
}[];

export type VehicleClassId = (typeof VEHICLE_CLASSES)[number]['id'];

export const vehicleClassIdSchema = z.enum(
  VEHICLE_CLASSES.map((vehicle) => vehicle.id) as [VehicleClassId, ...VehicleClassId[]],
);

export function vehicleClass(id: VehicleClassId) {
  const found = VEHICLE_CLASSES.find((vehicle) => vehicle.id === id);
  if (!found) throw new Error(`Unknown vehicle class: ${id}`);
  return found;
}

/**
 * The settings a user can change, and which are persisted for them.
 *
 * All optional with defaults, because the panel has to render before anyone has
 * touched it — and the defaults are the honest starting point rather than
 * placeholders: two trips a day is one commute each way, and 22 working days is
 * a month of weekdays minus a couple of holidays.
 */
export const commutePreferencesSchema = z.object({
  mode: commuteModeSchema.default('car'),
  vehicleClass: vehicleClassIdSchema.default('hatchback'),
  fuelType: fuelTypeSchema.default('PETROL'),
  /**
   * Overrides the vehicle class's figure when set. Null means "use the class
   * default", which is different from a stored number that happens to equal it:
   * changing class should move the mileage unless the user pinned one.
   */
  mileageKmPerLitre: z.number().min(1).max(100).nullable().default(null),
  tripsPerDay: z.number().int().min(1).max(10).default(COMMUTE_DEFAULTS.tripsPerDay),
  workingDaysPerMonth: z
    .number()
    .int()
    .min(1)
    .max(31)
    .default(COMMUTE_DEFAULTS.workingDaysPerMonth),
});

export type CommutePreferences = z.infer<typeof commutePreferencesSchema>;

/** The defaults, materialised — handy for a first render and for tests. */
export const DEFAULT_COMMUTE_PREFERENCES: CommutePreferences = commutePreferencesSchema.parse({});

/**
 * Settings that cannot contradict themselves.
 *
 * `mode: 'bike'` with `vehicleClass: 'sedan'` is two individually valid fields
 * and one nonsensical setting — D63 names it, and the UI produced it: switching
 * to Bike left a sedan selected and priced the ride on a car's consumption
 * (docs/ux-audit.md 1.3).
 *
 * The mode wins, because it is what the person clicked. A vehicle belonging to
 * another mode is replaced by that mode's default rather than refused: a 400
 * would punish an old client for a combination we can resolve unambiguously,
 * and there is no reading of "bike with a sedan" where the sedan is the intent.
 *
 * Mileage is dropped with the vehicle, for the reason it is nullable at all —
 * a pinned figure belongs to the vehicle it was pinned for.
 */
export function reconcileCommutePreferences(preferences: CommutePreferences): CommutePreferences {
  const wanted = vehicleClass(preferences.vehicleClass).mode;
  const expected = preferences.mode === 'transit' ? 'car' : preferences.mode;

  if (wanted === expected) return preferences;

  const replacement = VEHICLE_CLASSES.find((candidate) => candidate.mode === expected);
  if (!replacement) return preferences;

  return { ...preferences, vehicleClass: replacement.id, mileageKmPerLitre: null };
}

/**
 * Commute preferences as URL query parameters.
 *
 * The commute endpoint's answer depends entirely on these, so they travel in
 * the REQUEST rather than being read ambiently from the session. Two things
 * follow, and both were bugs before:
 *
 *  - the response can be cached by URL again, because the URL now determines
 *    it. It used to be cached for 120s while varying by the caller's stored
 *    settings, so changing a setting showed the old number until the cache
 *    expired — see docs/ux-audit.md 1.1;
 *  - a signed-out visitor gets real numbers from their own choices, with no
 *    server-side row to read them from.
 *
 * Every field is optional. Anything absent falls back to the session's stored
 * preference, then to the defaults — so an old client, or a link shared without
 * them, still gets a sensible answer.
 */
export const commuteParamsQuerySchema = z.object({
  mode: commuteModeSchema.optional(),
  vehicleClass: vehicleClassIdSchema.optional(),
  fuelType: fuelTypeSchema.optional(),
  mileageKmPerLitre: z.coerce.number().min(1).max(100).optional(),
  tripsPerDay: z.coerce.number().int().min(1).max(10).optional(),
  workingDaysPerMonth: z.coerce.number().int().min(1).max(31).optional(),
});

export type CommuteParamsQuery = z.infer<typeof commuteParamsQuerySchema>;

/**
 * Preferences to query parameters, dropping anything at its default.
 *
 * A shorter URL is not the point — a STABLE one is. Two clients holding the
 * same effective settings must produce the same URL, or the cache is keyed on
 * noise.
 */
export function commutePreferencesToQuery(preferences: CommutePreferences): Record<string, string> {
  const query: Record<string, string> = {
    mode: preferences.mode,
    vehicleClass: preferences.vehicleClass,
    fuelType: preferences.fuelType,
    tripsPerDay: String(preferences.tripsPerDay),
    workingDaysPerMonth: String(preferences.workingDaysPerMonth),
  };

  // Null means "use the class default" and must not become the string "null".
  if (preferences.mileageKmPerLitre !== null) {
    query.mileageKmPerLitre = String(preferences.mileageKmPerLitre);
  }

  return query;
}

/** Patch shape for the API: every field optional, nothing else accepted. */
export const commutePreferencesPatchSchema = commutePreferencesSchema.partial();

export type CommutePreferencesPatch = z.infer<typeof commutePreferencesPatchSchema>;

/**
 * The mileage actually used: the user's override, else the vehicle class's.
 *
 * One function so the precedence cannot differ between the panel that displays
 * it and the engine that spends it.
 */
export function effectiveMileage(preferences: CommutePreferences): number {
  return preferences.mileageKmPerLitre ?? vehicleClass(preferences.vehicleClass).mileageKmPerLitre;
}

// --- the engine -------------------------------------------------------------

export const commuteCostInputSchema = z.object({
  mode: commuteModeSchema,
  /** ONE WAY road distance in metres, from OSRM. Never straight-line. */
  roadDistanceMeters: z.number().nonnegative(),
  /** One-way duration in seconds, from the same route. */
  roadDurationSeconds: z.number().nonnegative().default(0),
  fuelType: fuelTypeSchema,
  /** Rupees per litre, or per kg for CNG. */
  fuelPricePerLitre: z.number().nonnegative(),
  mileageKmPerLitre: z.number().positive(),
  tripsPerDay: z.number().int().positive(),
  workingDaysPerMonth: z.number().int().positive(),
  /** Required for transit; ignored otherwise. */
  transitFare: transitFareConfigSchema.optional(),
});

/**
 * What a CALLER passes, and what the engine works with after parsing.
 *
 * Two names because the schema has a default: `roadDurationSeconds` is optional
 * going in and always present coming out. Typing the parameter as the output
 * type — which the first version did — makes the default unreachable and forces
 * every caller to supply a field the schema exists to fill in. Same split as
 * `ListingSearchInput` / `ListingSearchOptions`, for the same reason.
 */
export type CommuteCostInput = z.input<typeof commuteCostInputSchema>;
export type CommuteCostOptions = z.infer<typeof commuteCostInputSchema>;

export const commuteCostSchema = z.object({
  mode: commuteModeSchema,
  /** Rupees for one leg of the journey. */
  perTrip: z.number().nonnegative(),
  perDay: z.number().nonnegative(),
  perMonth: z.number().nonnegative(),
  /** One-way kilometres, so the UI never re-derives it from metres. */
  distanceKm: z.number().nonnegative(),
  /** Minutes one way, rounded. Zero when the route carried no duration. */
  durationMinutes: z.number().nonnegative(),
  /** Litres (or kg) burned per month. Zero for transit. */
  fuelPerMonth: z.number().nonnegative(),
  fuelType: fuelTypeSchema,
  currency: z.string(),
});

export type CommuteCost = z.infer<typeof commuteCostSchema>;

/**
 * What one trip costs, by mode.
 *
 * Fuel modes are `distance / mileage * pricePerLitre`. Transit is a slab fare —
 * `max(minFare, baseFare + perKm * km)` — because that is how BMTC, PMPML and
 * the Patna city buses actually charge, and no free API exposes their tables,
 * so the fares are per-city configuration (see `TransitFareConfig`).
 */
function perTripCost(input: CommuteCostOptions, distanceKm: number): number {
  if (input.mode === 'transit') {
    const fare = input.transitFare;
    // No fare table configured for the city: zero rather than a guess. The UI
    // hides the transit column instead of showing a made-up number.
    if (!fare) return 0;
    return Math.max(fare.minFare, fare.baseFare + fare.perKm * distanceKm);
  }

  return (distanceKm / input.mileageKmPerLitre) * input.fuelPricePerLitre;
}

/**
 * Rupees to two decimals.
 *
 * Rounded at the boundary rather than inside the arithmetic: rounding per trip
 * and then multiplying by 44 trips compounds the error into something a user
 * can notice against their own sums.
 */
function rupees(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeCommuteCost(input: CommuteCostInput): CommuteCost {
  const options = commuteCostInputSchema.parse(input);
  const distanceKm = options.roadDistanceMeters / 1000;
  const tripsPerMonth = options.tripsPerDay * options.workingDaysPerMonth;

  const perTrip = perTripCost(options, distanceKm);
  const fuelPerMonth =
    options.mode === 'transit' ? 0 : (distanceKm / options.mileageKmPerLitre) * tripsPerMonth;

  return {
    mode: options.mode,
    perTrip: rupees(perTrip),
    perDay: rupees(perTrip * options.tripsPerDay),
    perMonth: rupees(perTrip * tripsPerMonth),
    distanceKm: Math.round(distanceKm * 100) / 100,
    durationMinutes: Math.round(options.roadDurationSeconds / 60),
    fuelPerMonth: Math.round(fuelPerMonth * 100) / 100,
    fuelType: options.fuelType,
    currency: 'INR',
  };
}

// --- total true monthly cost ------------------------------------------------

export const monthlyOutlaySchema = z.object({
  /** Rent for a rental; null for a sale, where a monthly total is meaningless. */
  rent: z.number().int().nullable(),
  maintenance: z.number().int(),
  commute: z.number().nonnegative(),
  /** rent + maintenance + commute. Null when there is no rent to add to. */
  total: z.number().nullable(),
  /**
   * Commute as a percentage of rent, rounded to one decimal. Null when rent is
   * absent or zero — a share of nothing is not 0%, it is undefined, and showing
   * "0% of rent" for a sale listing would read as a claim.
   */
  commuteShareOfRent: z.number().nullable(),
  currency: z.string(),
});

export type MonthlyOutlay = z.infer<typeof monthlyOutlaySchema>;

/**
 * Total true monthly cost: rent plus maintenance plus commute.
 *
 * The number the product is built to rank by. Sale listings get `total: null`
 * rather than a fabricated monthly equivalent — turning a purchase price into a
 * monthly figure needs an interest rate and a tenure this product does not ask
 * for, and inventing them would be the least honest number on the page.
 */
export function computeMonthlyOutlay(input: {
  rent: number | null;
  maintenanceMonthly: number | null;
  commuteMonthly: number;
}): MonthlyOutlay {
  const maintenance = input.maintenanceMonthly ?? 0;
  const commute = rupees(input.commuteMonthly);
  const hasRent = input.rent !== null && input.rent > 0;

  return {
    rent: input.rent,
    maintenance,
    commute,
    total: hasRent ? rupees((input.rent ?? 0) + maintenance + commute) : null,
    commuteShareOfRent: hasRent ? Math.round((commute / (input.rent ?? 1)) * 1000) / 10 : null,
    currency: 'INR',
  };
}

/**
 * The bike / car / transit comparison, from ONE road distance per graph.
 *
 * Car and transit share the car distance; the bike figure needs its own,
 * because a bicycle graph routes through lanes a car cannot use and the
 * distances genuinely differ — measured at 9.82 km by car against 10.33 km by
 * bike for the same pair. Passing one distance for both would quietly make the
 * comparison meaningless.
 */
export const commuteComparisonSchema = z.object({
  car: commuteCostSchema.nullable(),
  bike: commuteCostSchema.nullable(),
  transit: commuteCostSchema.nullable(),
});

export type CommuteComparison = z.infer<typeof commuteComparisonSchema>;

export function compareCommuteModes(input: {
  car: { distanceMeters: number; durationSeconds: number } | null;
  bike: { distanceMeters: number; durationSeconds: number } | null;
  fuelType: FuelType;
  fuelPricePerLitre: number;
  mileageKmPerLitre: number;
  bikeMileageKmPerLitre: number;
  tripsPerDay: number;
  workingDaysPerMonth: number;
  transitFare?: TransitFareConfig | undefined;
}): CommuteComparison {
  const shared = {
    fuelType: input.fuelType,
    fuelPricePerLitre: input.fuelPricePerLitre,
    tripsPerDay: input.tripsPerDay,
    workingDaysPerMonth: input.workingDaysPerMonth,
  };

  return {
    car: input.car
      ? computeCommuteCost({
          ...shared,
          mode: 'car',
          roadDistanceMeters: input.car.distanceMeters,
          roadDurationSeconds: input.car.durationSeconds,
          mileageKmPerLitre: input.mileageKmPerLitre,
        })
      : null,
    bike: input.bike
      ? computeCommuteCost({
          ...shared,
          mode: 'bike',
          roadDistanceMeters: input.bike.distanceMeters,
          roadDurationSeconds: input.bike.durationSeconds,
          mileageKmPerLitre: input.bikeMileageKmPerLitre,
        })
      : null,
    transit:
      input.car && input.transitFare
        ? computeCommuteCost({
            ...shared,
            mode: 'transit',
            roadDistanceMeters: input.car.distanceMeters,
            roadDurationSeconds: input.car.durationSeconds,
            // Irrelevant for a fare table, but the schema wants a positive
            // number and a zero would read as "this bus does 0 km/l".
            mileageKmPerLitre: 1,
            transitFare: input.transitFare,
          })
        : null,
  };
}
