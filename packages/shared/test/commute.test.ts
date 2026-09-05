import { describe, expect, it } from 'vitest';
import {
  compareCommuteModes,
  computeCommuteCost,
  computeMonthlyOutlay,
  DEFAULT_COMMUTE_PREFERENCES,
  effectiveMileage,
  routeProfileForMode,
  vehicleClass,
} from '../src/commute.js';
import type { TransitFareConfig } from '../src/geo/schemas.js';

/**
 * The cost engine, pinned with arithmetic anyone can redo by hand.
 *
 * This is the product's argument, so the numbers are checked against a sum
 * written out in the comment rather than against a snapshot — a snapshot test
 * here would happily lock in a wrong formula.
 */
const PATNA_FARE: TransitFareConfig = {
  currency: 'INR',
  baseFare: 10,
  perKm: 1.5,
  minFare: 10,
  notes: 'Patna city bus (BSRTC), approximate slab fares',
};

describe('computeCommuteCost — car', () => {
  it('costs a trip as distance over mileage times price', () => {
    // 8 / 15 = 0.533333 l; x 107.24 = 57.194666 per trip.
    // x 2 trips x 22 days = 44 trips = 2516.5653 per month.
    const cost = computeCommuteCost({
      mode: 'car',
      roadDistanceMeters: 8_000,
      roadDurationSeconds: 22 * 60,
      fuelType: 'PETROL',
      fuelPricePerLitre: 107.24,
      mileageKmPerLitre: 15,
      tripsPerDay: 2,
      workingDaysPerMonth: 22,
    });

    expect(cost.perTrip).toBeCloseTo(57.19, 2);
    expect(cost.perDay).toBeCloseTo(114.39, 2);
    expect(cost.perMonth).toBeCloseTo(2516.57, 2);
    expect(cost.distanceKm).toBe(8);
    expect(cost.durationMinutes).toBe(22);
    // 8 km x 44 trips / 15 = 23.47 litres.
    expect(cost.fuelPerMonth).toBeCloseTo(23.47, 2);
  });

  it('rounds only at the boundary, never per trip', () => {
    // Per-trip rounding then multiplying compounds into something a user can
    // notice against their own sums. 1.004 per trip x 44 is 44.18, not 44.00.
    const cost = computeCommuteCost({
      mode: 'car',
      roadDistanceMeters: 150,
      fuelType: 'PETROL',
      fuelPricePerLitre: 100.4,
      mileageKmPerLitre: 15,
      tripsPerDay: 2,
      workingDaysPerMonth: 22,
    });

    expect(cost.perMonth).toBeCloseTo(44.18, 2);
  });

  it('is zero at zero distance rather than undefined', () => {
    const cost = computeCommuteCost({
      mode: 'car',
      roadDistanceMeters: 0,
      fuelType: 'PETROL',
      fuelPricePerLitre: 107.24,
      mileageKmPerLitre: 15,
      tripsPerDay: 2,
      workingDaysPerMonth: 22,
    });

    expect(cost.perMonth).toBe(0);
    expect(cost.fuelPerMonth).toBe(0);
  });
});

describe('computeCommuteCost — transit', () => {
  it('uses the slab fare, not fuel', () => {
    // 10 base + 1.5 x 8 km = 22 per trip; x 44 = 968 per month.
    const cost = computeCommuteCost({
      mode: 'transit',
      roadDistanceMeters: 8_000,
      fuelType: 'PETROL',
      fuelPricePerLitre: 107.24,
      mileageKmPerLitre: 1,
      tripsPerDay: 2,
      workingDaysPerMonth: 22,
      transitFare: PATNA_FARE,
    });

    expect(cost.perTrip).toBe(22);
    expect(cost.perMonth).toBe(968);
    // No fuel is burned by the passenger.
    expect(cost.fuelPerMonth).toBe(0);
  });

  it('never charges below the minimum fare', () => {
    // 10 + 1.5 x 0.4 = 10.6, already above minFare — but a 0 km trip must
    // still cost a boarding fare, not nothing.
    const cost = computeCommuteCost({
      mode: 'transit',
      roadDistanceMeters: 0,
      fuelType: 'PETROL',
      fuelPricePerLitre: 107.24,
      mileageKmPerLitre: 1,
      tripsPerDay: 2,
      workingDaysPerMonth: 22,
      transitFare: PATNA_FARE,
    });

    expect(cost.perTrip).toBe(10);
  });

  it('costs nothing when the city has no fare table, rather than guessing', () => {
    // The UI hides the transit column on a zero rather than showing an
    // invented number. A made-up bus fare is the least defensible figure the
    // page could carry.
    const cost = computeCommuteCost({
      mode: 'transit',
      roadDistanceMeters: 8_000,
      fuelType: 'PETROL',
      fuelPricePerLitre: 107.24,
      mileageKmPerLitre: 1,
      tripsPerDay: 2,
      workingDaysPerMonth: 22,
    });

    expect(cost.perMonth).toBe(0);
  });
});

describe('computeMonthlyOutlay', () => {
  it('adds rent, maintenance and commute', () => {
    const outlay = computeMonthlyOutlay({
      rent: 18_000,
      maintenanceMonthly: 1_500,
      commuteMonthly: 2_516.57,
    });

    expect(outlay.total).toBeCloseTo(22_016.57, 2);
    // 2516.57 / 18000 = 13.98%
    expect(outlay.commuteShareOfRent).toBeCloseTo(14, 1);
  });

  it('treats a missing maintenance figure as zero, not as unknown', () => {
    const outlay = computeMonthlyOutlay({
      rent: 18_000,
      maintenanceMonthly: null,
      commuteMonthly: 1_000,
    });

    expect(outlay.maintenance).toBe(0);
    expect(outlay.total).toBe(19_000);
  });

  it('refuses to invent a monthly total for a sale listing', () => {
    // Turning a purchase price into a monthly figure needs an interest rate and
    // a tenure this product never asks for. Null, not a fabrication.
    const outlay = computeMonthlyOutlay({
      rent: null,
      maintenanceMonthly: 2_000,
      commuteMonthly: 1_000,
    });

    expect(outlay.total).toBeNull();
    expect(outlay.commuteShareOfRent).toBeNull();
  });

  it('reports an undefined share rather than 0% when rent is zero', () => {
    const outlay = computeMonthlyOutlay({
      rent: 0,
      maintenanceMonthly: 0,
      commuteMonthly: 1_000,
    });

    expect(outlay.commuteShareOfRent).toBeNull();
  });
});

describe('compareCommuteModes', () => {
  it('prices the bike on its OWN distance, not the car distance', () => {
    // Measured for one real pair in Bengaluru: 9.82 km by car, 10.33 km by
    // bike, because a bicycle graph routes through lanes a car cannot use.
    // Passing one distance for both would make the comparison meaningless.
    const comparison = compareCommuteModes({
      car: { distanceMeters: 9_820, durationSeconds: 678 },
      bike: { distanceMeters: 10_330, durationSeconds: 2_526 },
      fuelType: 'PETROL',
      fuelPricePerLitre: 102.86,
      mileageKmPerLitre: 15,
      bikeMileageKmPerLitre: 45,
      tripsPerDay: 2,
      workingDaysPerMonth: 22,
      transitFare: PATNA_FARE,
    });

    const { car, bike } = comparison;
    // Narrowed rather than asserted with `!`: if either mode were missing, the
    // interesting assertion below would silently not run.
    expect(car).not.toBeNull();
    expect(bike).not.toBeNull();
    if (!car || !bike) throw new Error('both modes were priced, so both must be present');

    expect(car.distanceKm).toBe(9.82);
    expect(bike.distanceKm).toBe(10.33);
    // The bike is further AND much cheaper, which is the point of showing both.
    expect(bike.perMonth).toBeLessThan(car.perMonth / 2);
  });

  it('prices transit off the car distance, since a bus uses roads', () => {
    const comparison = compareCommuteModes({
      car: { distanceMeters: 8_000, durationSeconds: 1_320 },
      bike: null,
      fuelType: 'PETROL',
      fuelPricePerLitre: 107.24,
      mileageKmPerLitre: 15,
      bikeMileageKmPerLitre: 45,
      tripsPerDay: 2,
      workingDaysPerMonth: 22,
      transitFare: PATNA_FARE,
    });

    expect(comparison.transit?.perMonth).toBe(968);
    expect(comparison.bike).toBeNull();
  });

  it('omits transit entirely when the city has no fare table', () => {
    const comparison = compareCommuteModes({
      car: { distanceMeters: 8_000, durationSeconds: 1_320 },
      bike: null,
      fuelType: 'PETROL',
      fuelPricePerLitre: 107.24,
      mileageKmPerLitre: 15,
      bikeMileageKmPerLitre: 45,
      tripsPerDay: 2,
      workingDaysPerMonth: 22,
    });

    expect(comparison.transit).toBeNull();
  });
});

describe('preferences', () => {
  it('defaults to one commute each way over a month of weekdays', () => {
    expect(DEFAULT_COMMUTE_PREFERENCES.tripsPerDay).toBe(2);
    expect(DEFAULT_COMMUTE_PREFERENCES.workingDaysPerMonth).toBe(22);
    expect(DEFAULT_COMMUTE_PREFERENCES.mode).toBe('car');
  });

  it('takes mileage from the vehicle class until the user pins one', () => {
    // Null is not the same as a stored number that happens to match: changing
    // class should move the mileage unless it was pinned deliberately.
    expect(effectiveMileage({ ...DEFAULT_COMMUTE_PREFERENCES, vehicleClass: 'suv' })).toBe(10);
    expect(
      effectiveMileage({
        ...DEFAULT_COMMUTE_PREFERENCES,
        vehicleClass: 'suv',
        mileageKmPerLitre: 12,
      }),
    ).toBe(12);
  });

  it('routes a bike commute on the bicycle graph and everything else on the car one', () => {
    expect(routeProfileForMode('bike')).toBe('bike');
    expect(routeProfileForMode('car')).toBe('car');
    // A bus uses roads, so its distance comes off the car graph.
    expect(routeProfileForMode('transit')).toBe('car');
  });

  it('keeps every vehicle class honest about city traffic', () => {
    // A hatchback rated 20 km/l on a highway does far worse at 9am, and a cost
    // engine that flatters the commute argues against the product's own point.
    for (const vehicle of ['hatchback', 'sedan', 'suv'] as const) {
      expect(vehicleClass(vehicle).mileageKmPerLitre).toBeLessThanOrEqual(15);
    }
  });
});
