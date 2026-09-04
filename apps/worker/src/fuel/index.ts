import type { FuelAdapter } from './adapter.js';
import { bankbazaarAdapter } from './bankbazaar.js';
import { goodreturnsAdapter } from './goodreturns.js';
import { petrolPriceIndiaAdapter } from './petrolpriceindia.js';

/**
 * Every fuel adapter, in the order the job runs them.
 *
 * GoodReturns first because it is the only independent feed for CNG and the
 * most reliable of the three; the shared-feed pair follows. Order does not
 * decide the answer — `pickConsensus` takes the median, precisely so that one
 * source being listed first cannot make its number authoritative (D62).
 */
export const FUEL_ADAPTERS: readonly FuelAdapter[] = [
  goodreturnsAdapter,
  bankbazaarAdapter,
  petrolPriceIndiaAdapter,
];

export { runAdapter, type FuelAdapter } from './adapter.js';
export { FUEL_USER_AGENT } from './fetch-page.js';
