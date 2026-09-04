// The compile-time enum guard is imported for its side effect of being checked.
import './enum-guard.js';

export { prisma, disconnectPrisma } from './client.js';
export { probeDatabase, type DatabaseProbe } from './probe.js';
export {
  searchListingsInRadius,
  listingsInRadius,
  findSimilarListings,
  searchPlacesLocally,
  straightLineDistanceMeters,
  resolveCityForPoint,
  resolveCoverage,
  recordCoverageRequest,
  decodeCursor,
  COVERAGE_REQUEST_CLUSTER_METERS,
  type CityMatch,
  type ListingCandidate,
  type CoverageBbox,
  type CoverageCity,
  type CoverageResolution,
  type NearestCoverageCity,
  type SimilarListing,
  type LocalPlaceRow,
} from './geo-queries.js';

// Generated Prisma types and enums, so nothing outside this package reaches into
// the generated directory directly.
export * from '../generated/prisma/enums.js';
export type * from '../generated/prisma/models.js';
