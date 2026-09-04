/**
 * The fuel-price sources, as a registry rather than as knowledge inside each
 * adapter.
 *
 * It exists here, in the city config's own package, for one reason: the
 * validator has to be able to fail CI when a **configured city has no slug for
 * a configured source**. That is the exact failure this registry prevents — one
 * adapter silently returning nothing for one city while the others cover for
 * it, which looks like a working scraper and a quiet city.
 *
 * Each id is the key used in `CityConfig.fuelSlugs` and in the `source` column
 * of a `FuelPrice` row, so attribution survives into the database and the UI.
 * The adapters themselves live in `apps/worker/src/fuel/`; this file is only
 * the identity, the attribution and what each source actually publishes.
 *
 * **Every entry here was verified against the live site**, and two of the three
 * originally listed were removed because they cannot work — see DECISIONS.md
 * D62 for the measurements. The lesson worth carrying: two of them returned
 * HTTP 200 with the WRONG CITY's price, which no plausibility band can catch,
 * so every adapter has to verify the city name appears in the response.
 */
/** The fuels a source can publish. Mirrors `FuelType` without importing it. */
export type FuelSourceFuel = 'PETROL' | 'DIESEL' | 'CNG';

export interface FuelSource {
  id: string;
  /** Shown next to a price, so a user can see where the number came from. */
  label: string;
  /** Site root. Adapters build their own paths from the per-city slug. */
  homepage: string;
  /**
   * Fuel types this source publishes, **as measured**, not as advertised. CNG
   * coverage is genuinely patchier than petrol and diesel, which is why the
   * list is per-source rather than assumed uniform.
   */
  fuels: readonly FuelSourceFuel[];
  /**
   * Which other source ids share this one's upstream data.
   *
   * Not decoration. `bankbazaar` and `petrolpriceindia` return **identical**
   * figures — Bengaluru diesel was 98.8 from both while goodreturns said 99.56
   * — so they are one feed behind two front doors. They still add
   * **availability** redundancy, because either site can be down alone, but
   * they add no independent verification, and a median across all three is
   * really "goodreturns versus the shared feed". Saying so here stops a future
   * reader mistaking three sources for three opinions.
   */
  sharesFeedWith?: readonly string[];
}

export const FUEL_SOURCES = [
  {
    id: 'goodreturns',
    label: 'GoodReturns',
    homepage: 'https://www.goodreturns.in',
    // The only source of the three that publishes CNG per city.
    fuels: ['PETROL', 'DIESEL', 'CNG'],
  },
  {
    id: 'bankbazaar',
    label: 'BankBazaar',
    homepage: 'https://www.bankbazaar.com',
    // CNG pages 404 for every city; petrol and diesel are solid.
    fuels: ['PETROL', 'DIESEL'],
    sharesFeedWith: ['petrolpriceindia'],
  },
  {
    id: 'petrolpriceindia',
    label: 'Petrol Price India',
    homepage: 'https://www.petrolpriceindia.com',
    fuels: ['PETROL', 'DIESEL', 'CNG'],
    sharesFeedWith: ['bankbazaar'],
  },
] as const satisfies readonly FuelSource[];

export type FuelSourceId = (typeof FUEL_SOURCES)[number]['id'];

export const FUEL_SOURCE_IDS: readonly FuelSourceId[] = FUEL_SOURCES.map((source) => source.id);

export function fuelSourceById(id: string): FuelSource | undefined {
  return FUEL_SOURCES.find((source) => source.id === id);
}

/**
 * The registry seen through the interface rather than through its literal
 * types.
 *
 * `as const satisfies` above is what derives `FuelSourceId` from the ids, but
 * it also narrows each `fuels` array to exactly what that source lists — so
 * `bankbazaar.fuels.includes('CNG')` would be a type error rather than a
 * runtime `false`. This view widens them back to the declared interface, which
 * is what a lookup needs, without casting anything away.
 */
const SOURCES: readonly FuelSource[] = FUEL_SOURCES;

/** Which sources claim to publish a given fuel, so the job asks nobody else. */
export function sourcesForFuel(fuel: FuelSourceFuel): readonly FuelSource[] {
  return SOURCES.filter((source) => source.fuels.includes(fuel));
}

/**
 * How many INDEPENDENT feeds cover a fuel type.
 *
 * Counts shared-feed sources once, which is the number that actually answers
 * "would we notice if this price were wrong". Petrol and diesel have two;
 * CNG has two on paper and, because goodreturns and petrolpriceindia are the
 * two, genuinely two.
 */
export function independentFeedCount(fuel: FuelSourceFuel): number {
  const groups: string[][] = [];

  for (const source of sourcesForFuel(fuel)) {
    const family = [source.id, ...(source.sharesFeedWith ?? [])].sort().join('+');
    if (!groups.some((group) => group.join('+') === family)) {
      groups.push(family.split('+'));
    }
  }

  return groups.length;
}
