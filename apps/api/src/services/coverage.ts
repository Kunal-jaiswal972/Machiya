import { resolveCoverage, type CoverageResolution } from '@machiya/db';
import {
  OUT_OF_COVERAGE_CODE,
  coverageMessage,
  type CityBbox,
  type Coordinate,
  type CoverageSet,
  type CoveredCity,
  type OutOfCoverage,
} from '@machiya/shared';
import { CITIES, bboxUnion } from '@machiya/shared/cities';
import { geoEpoch, geoManifest } from '../geo/manifest.js';
import { logger } from '../logger.js';
import { HttpError } from '../middleware/error-handler.js';

/**
 * Coverage, as every geo entry point sees it.
 *
 * **One function answers "is this point covered", and everything calls it
 * before doing any work** — search, office selection, reverse geocode, listing
 * create, routing. Nothing downstream should ever receive a point it cannot
 * handle: an OSRM 400 for an out-of-graph coordinate is a symptom, and this is
 * the place it is caught.
 *
 * See DECISIONS.md D52 for why the frontier comes from the manifest rather than
 * from the city config, and D53 for why out-of-coverage is a 200 for a read and
 * a 422 for a write.
 */

/**
 * The padded boxes that define the frontier.
 *
 * The **manifest's** boxes when there is one, because the manifest records what
 * `osmium extract` actually cut — and coverage is a claim about the artifacts,
 * not about intent. A fourth city added to the config but not yet built is
 * exactly the divergence `geoArtifactStatus()` shouts about at boot (D51); it
 * must not also silently start claiming coverage of a city with no road graph.
 *
 * The config's boxes when there is no manifest at all, which is a clone that
 * has never run `pnpm bootstrap`. The core stack is usable in that state (D6) —
 * PostGIS radius search needs no artifacts — so refusing every point would
 * break more than it protects.
 */
function frontierBboxes(): CityBbox[] {
  const manifest = geoManifest();

  if (manifest) {
    return manifest.cities.map((city) => city.paddedBbox);
  }

  return CITIES.map((city) => city.paddedBbox);
}

/**
 * The public coverage set, built once.
 *
 * Safe to memoise: the city config is module-level and the manifest is read
 * once at boot, so neither can change under a running process — which is
 * deliberate, because an epoch that moved mid-request would split one request's
 * reads from its writes (D46).
 */
let cachedSet: CoverageSet | undefined;

export function coverageSet(): CoverageSet {
  if (cachedSet) return cachedSet;

  const frontier = frontierBboxes();

  const cities: CoveredCity[] = CITIES.map((city) => ({
    slug: city.slug,
    name: city.name,
    state: city.state,
    centroid: city.centroid,
    bbox: city.bbox,
    paddedBbox: city.paddedBbox,
    // Cast rather than re-validated: `CityBoundary.coordinates` is typed as the
    // union of both nestings and the generated file is the source both this and
    // `ST_GeomFromGeoJSON` read, so a runtime parse here would only be able to
    // fail on data the seed has already accepted.
    boundary: city.boundary
      ? ({
          type: city.boundary.type,
          coordinates: city.boundary.coordinates,
        } as CoveredCity['boundary'])
      : null,
  }));

  cachedSet = {
    cities,
    maxBounds: bboxUnion(frontier),
    epoch: geoEpoch(),
  };

  return cachedSet;
}

/** Just the names and centroids, for the out-of-coverage message. */
function supportedCities(): OutOfCoverage['supportedCities'] {
  return coverageSet().cities.map((city) => ({
    slug: city.slug,
    name: city.name,
    centroid: city.centroid,
  }));
}

/**
 * The out-of-coverage payload for one point.
 *
 * `label` is whatever the geocoder managed to call the point, when anything
 * did. It is carried through so the capture form can pre-fill "tell me when you
 * cover **Mumbai**" rather than "tell me when you cover 19.076, 72.877", and so
 * the `CoverageRequest` row records a readable place rather than only a pair of
 * floats.
 */
export function outOfCoverageFor(input: {
  coordinate?: Coordinate | undefined;
  nearest: CoverageResolution['nearest'];
  label?: string | undefined;
}): OutOfCoverage {
  return {
    supportedCities: supportedCities(),
    nearest: input.nearest
      ? {
          slug: input.nearest.slug,
          name: input.nearest.name,
          distanceMeters: input.nearest.distanceMeters,
        }
      : null,
    requested: input.coordinate ?? null,
    requestedLabel: input.label ?? null,
  };
}

/**
 * The out-of-coverage payload when there is no point to speak of — an
 * autocomplete query that matched nothing anywhere.
 *
 * No nearest city, because "nearest to what?" has no answer: a text query is
 * not a coordinate. The message degrades to "Machiya covers Patna, Bengaluru
 * and Pune." with no distance clause, which `coverageMessage` already handles.
 */
export function outOfCoverageForQuery(): OutOfCoverage {
  return {
    supportedCities: supportedCities(),
    nearest: null,
    requested: null,
    requestedLabel: null,
  };
}

/**
 * Is this point covered, and if so which city is it in?
 *
 * The one call. Everything else in this file shapes its answer.
 */
export async function checkCoverage(coordinate: Coordinate): Promise<CoverageResolution> {
  return resolveCoverage(coordinate, frontierBboxes());
}

/**
 * An out-of-coverage refusal, as an error a route can simply not catch.
 *
 * Carries the payload rather than only a message, so the wizard can render the
 * supported cities as one-tap actions instead of parsing them out of prose.
 */
export class OutOfCoverageError extends HttpError {
  constructor(readonly coverage: OutOfCoverage) {
    super(422, OUT_OF_COVERAGE_CODE, coverageMessage(coverage));
    this.name = 'OutOfCoverageError';
  }

  override body() {
    return { coverage: this.coverage };
  }
}

/**
 * Coverage as a precondition, for a WRITE.
 *
 * Throws rather than returning a state, because there is nothing sensible to
 * write: a listing at a Mumbai coordinate accepted and filed under Pune is data
 * corruption that surfaces months later as a listing that will not appear in
 * its own city. Reads use `checkCoverage` and render the state instead.
 *
 * Returns the resolved city on success, so a caller never resolves twice.
 */
export async function assertCovered(
  coordinate: Coordinate,
  context: { label?: string | undefined } = {},
): Promise<{ id: string; slug: string; name: string; method: 'covers' | 'nearest' }> {
  const resolution = await checkCoverage(coordinate);

  if (!resolution.covered) {
    logger.info(
      {
        lat: coordinate.lat,
        lng: coordinate.lng,
        nearest: resolution.nearest?.slug ?? null,
        nearestKm: resolution.nearest ? Math.round(resolution.nearest.distanceMeters / 1000) : null,
      },
      'write refused: point is outside coverage',
    );

    throw new OutOfCoverageError(
      outOfCoverageFor({
        coordinate,
        nearest: resolution.nearest,
        ...(context.label ? { label: context.label } : {}),
      }),
    );
  }

  if (resolution.method === 'nearest') {
    // Inside coverage, in a gap between two boundaries. The right answer, at
    // the wrong confidence — logged so a boundary that needs re-deriving shows
    // up as a pattern rather than as a support ticket (D50).
    logger.warn(
      {
        lat: coordinate.lat,
        lng: coordinate.lng,
        assigned: resolution.city.slug,
        distanceMeters: Math.round(resolution.distanceMeters),
      },
      'point is inside coverage but no city boundary; assigned by nearest centroid',
    );
  }

  return { ...resolution.city, method: resolution.method };
}
