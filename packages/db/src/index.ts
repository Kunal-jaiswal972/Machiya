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
//
// `Prisma` carries the argument types (`Prisma.ListingInclude` and friends). A
// service composing a reusable `include` object needs it: without a contextual
// type, `orderBy: [{ sortOrder: 'asc' }]` infers `string` rather than the
// SortOrder enum and every query using it fails to compile.
export type { Prisma } from '../generated/prisma/client.js';
export * from '../generated/prisma/enums.js';
export type * from '../generated/prisma/models.js';
