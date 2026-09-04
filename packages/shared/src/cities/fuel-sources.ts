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
 * The adapters themselves live in the worker (brief step 8); this file is only
 * the identity and the attribution.
 */
export interface FuelSource {
  id: string;
  /** Shown next to a price, so a user can see where the number came from. */
  label: string;
  /** Site root. Adapters build their own paths from the per-city slug. */
  homepage: string;
  /**
   * Fuel types this source publishes. CNG coverage is patchy across all of
   * them, which is why there is more than one source per type.
   */
  fuels: readonly ('PETROL' | 'DIESEL' | 'CNG')[];
}

export const FUEL_SOURCES = [
  {
    id: 'goodreturns',
    label: 'GoodReturns',
    homepage: 'https://www.goodreturns.in',
    fuels: ['PETROL', 'DIESEL'],
  },
  {
    id: 'mypetrolprice',
    label: 'MyPetrolPrice',
    homepage: 'https://www.mypetrolprice.com',
    fuels: ['PETROL', 'DIESEL', 'CNG'],
  },
  {
    id: 'ndtv',
    label: 'NDTV Fuel Prices',
    homepage: 'https://www.ndtv.com/fuel-prices',
    fuels: ['PETROL', 'DIESEL'],
  },
] as const satisfies readonly FuelSource[];

export type FuelSourceId = (typeof FUEL_SOURCES)[number]['id'];

export const FUEL_SOURCE_IDS: readonly FuelSourceId[] = FUEL_SOURCES.map((source) => source.id);

export function fuelSourceById(id: string): FuelSource | undefined {
  return FUEL_SOURCES.find((source) => source.id === id);
}
