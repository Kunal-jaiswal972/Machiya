import { describe, expect, it } from 'vitest';
import { padBbox } from '../src/cities/bbox.js';
import { CITIES, type CityConfig } from '../src/cities/config.js';
import { FUEL_SOURCE_IDS } from '../src/cities/fuel-sources.js';
import { validateCities } from '../src/cities/validate.js';
import { TRANSIT_FARE_STALE_AFTER_DAYS } from '../src/geo/schemas.js';

/**
 * The validator, against deliberately broken configs.
 *
 * A validator with no tests is a validator nobody trusts when it fires — and
 * worse, one nobody notices when it stops firing. Each case below is a way a
 * fourth city has actually been added wrong: a locality typo that puts it in
 * the wrong state, a fuel source nobody added a slug for, a bbox copied from a
 * neighbouring city.
 */
function rulesOf(cities: CityConfig[], severity: 'error' | 'warning' = 'error'): string[] {
  return validateCities(cities)
    .filter((issue) => issue.severity === severity)
    .map((issue) => issue.rule);
}

function baseCity(): CityConfig {
  const bbox = { minLng: 84.95, minLat: 25.5, maxLng: 85.3, maxLat: 25.68 };
  return {
    slug: 'testville',
    name: 'Testville',
    state: 'Bihar',
    zone: 'eastern-zone',
    centroid: { lat: 25.5941, lng: 85.1376 },
    bbox,
    paddedBbox: padBbox(bbox),
    boundary: null,
    defaultFuelType: 'PETROL',
    transitFare: { currency: 'INR', baseFare: 10, perKm: 1.5, minFare: 10 },
    // Reviewed today, so a fixture cannot fail the staleness rule as it ages
    // and send a future reader hunting for a bug in whatever they just changed.
    transitFareReviewedOn: new Date().toISOString().slice(0, 10),
    localities: [
      { name: 'One', lat: 25.6127, lng: 85.1145 },
      { name: 'Two', lat: 25.59, lng: 85.156 },
      { name: 'Three', lat: 25.6053, lng: 85.1567 },
    ],
    // Built from the registry rather than listed, so adding or replacing a
    // source cannot leave this fixture quietly incomplete — which is exactly
    // the failure the fuel-slug rule below exists to catch.
    fuelSlugs: Object.fromEntries(
      FUEL_SOURCE_IDS.map((id) => [id, 'testville']),
    ) as CityConfig['fuelSlugs'],
  };
}

describe('validateCities', () => {
  it('passes the three real seed cities', () => {
    expect(rulesOf([...CITIES])).toEqual([]);
  });

  it('warns, but does not fail, when a boundary polygon is missing', () => {
    // Generated rather than hand-written, so an unbuilt one is a degraded
    // mode (nearest-centroid assignment), not a broken config.
    expect(rulesOf([baseCity()], 'warning')).toContain('boundary');
    expect(rulesOf([baseCity()])).toEqual([]);
  });

  it('fails a city with no fuel slug for a configured source', () => {
    const city = baseCity();
    // The realistic mistake: a source is added to the registry and one city's
    // record is not updated. That source then silently returns nothing for
    // this city while the others cover for it.
    city.fuelSlugs = { ...city.fuelSlugs, [FUEL_SOURCE_IDS[0] as string]: '' };
    expect(rulesOf([city])).toContain('fuel-slug');
  });

  it('fails a locality with no coordinates', () => {
    const city = baseCity();
    city.localities = [...city.localities, { name: 'Nowhere', lat: Number.NaN, lng: Number.NaN }];
    expect(rulesOf([city])).toContain('locality-coordinates');
  });

  it('fails a locality outside its city bbox', () => {
    const city = baseCity();
    // Koramangala's coordinates under a Patna record — a copy-paste away.
    city.localities = [...city.localities, { name: 'Koramangala', lat: 12.9352, lng: 77.6245 }];
    expect(rulesOf([city])).toContain('locality-inside-city');
  });

  it('fails when two padded extracts overlap enough to make assignment a guess', () => {
    const a = baseCity();
    const b = baseCity();
    b.slug = 'testville-north';
    // 11 km north: the administrative boxes do not touch, but with 9 km of
    // padding each the extracts overlap by far more than the tolerance.
    b.bbox = { minLng: 84.95, minLat: 25.6, maxLng: 85.3, maxLat: 25.78 };
    b.paddedBbox = padBbox(b.bbox);
    b.centroid = { lat: 25.69, lng: 85.1376 };
    b.localities = b.localities.map((locality) => ({ ...locality, lat: locality.lat + 0.1 }));

    expect(rulesOf([a, b])).toContain('padded-overlap');
  });

  it('fails a duplicate slug', () => {
    expect(rulesOf([baseCity(), baseCity()])).toContain('unique-slug');
  });

  it('fails a slug that cannot go in a URL', () => {
    const city = baseCity();
    city.slug = 'New Delhi';
    expect(rulesOf([city])).toContain('record');
  });

  it('fails an inverted bbox', () => {
    const city = baseCity();
    city.bbox = { minLng: 85.3, minLat: 25.68, maxLng: 84.95, maxLat: 25.5 };
    expect(rulesOf([city])).toContain('record');
  });

  it('fails a city with almost no localities', () => {
    const city = baseCity();
    city.localities = [{ name: 'Only', lat: 25.6127, lng: 85.1145 }];
    // Would otherwise pass everything, then seed nothing and answer no
    // autocomplete — the "looks healthy" failure this exists for.
    expect(rulesOf([city])).toContain('record');
  });

  it('fails an empty city list', () => {
    expect(rulesOf([])).toContain('non-empty');
  });
});

describe('transit fare staleness', () => {
  /**
   * The one commute input nothing can refresh on its own.
   *
   * Fuel prices are scraped hourly and the OSM artifacts have an epoch that
   * makes stale answers unreachable. Bus fares have neither: no free API
   * publishes them, so they sit in the city record and rot in total silence,
   * and a transit commute costed from a three-year-old slab is wrong with no
   * symptom anywhere. This is the only thing standing between that and a rent
   * decision. See DECISIONS.md D73.
   */
  it('says nothing while the fares are recent', () => {
    const fresh = withReviewDate(new Date().toISOString().slice(0, 10));

    expect(validateCities(fresh).filter((issue) => issue.rule.startsWith('transit-fare'))).toEqual(
      [],
    );
  });

  it('warns once per city when they are older than the threshold', () => {
    const past = new Date(Date.now() - (TRANSIT_FARE_STALE_AFTER_DAYS + 5) * 86_400_000);
    const stale = withReviewDate(past.toISOString().slice(0, 10));

    const warnings = validateCities(stale).filter((issue) => issue.rule === 'transit-fare-stale');

    expect(warnings).toHaveLength(stale.length);
    expect(warnings[0]?.severity).toBe('warning');
    // A warning, not an error: stale fares are a prompt to go and check, not a
    // reason to fail a build that has nothing to do with them.
    expect(warnings[0]?.message).toContain('bump transitFareReviewedOn');
  });

  it('does not warn one day before the threshold', () => {
    const past = new Date(Date.now() - (TRANSIT_FARE_STALE_AFTER_DAYS - 1) * 86_400_000);

    expect(
      validateCities(withReviewDate(past.toISOString().slice(0, 10))).filter(
        (issue) => issue.rule === 'transit-fare-stale',
      ),
    ).toEqual([]);
  });

  it('errors rather than warns when the date is not a date', () => {
    const issues = validateCities(withReviewDate('last tuesday'));

    // A malformed date is a config bug, and treating it as merely stale would
    // let it sit there being warned about forever.
    expect(issues.some((issue) => issue.severity === 'error')).toBe(true);
  });
});

function withReviewDate(transitFareReviewedOn: string) {
  return CITIES.map((city) => ({ ...city, transitFareReviewedOn }));
}
