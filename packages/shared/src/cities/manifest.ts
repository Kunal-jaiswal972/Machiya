/**
 * The OSM artifact manifest, and the geo epoch derived from it.
 *
 * Routes, POIs and geocodes are all **derived from the OSM artifacts** —
 * `osm-data/merged.osm.pbf` and the OSRM graphs, Nominatim database and
 * Overpass database built from it. A cached route is therefore only valid for
 * the artifacts that produced it, and after a re-cut with different bounds the
 * same key can name a different answer.
 *
 * The epoch closes that: it is a short hash of the artifact-relevant city
 * config plus the checksums of the source extracts, written into
 * `osm-data/manifest.json` by `scripts/bootstrap.sh` and prefixed onto every
 * derived Redis key. A rebuild changes the epoch, so every derived entry
 * becomes unreachable with nobody having to remember to flush anything, and
 * the orphans expire on their own TTL. It also means a partial rebuild on one
 * machine cannot serve another machine's geometry.
 *
 * This module is deliberately free of `node:fs`: the writer is
 * `scripts/geo-manifest.ts` and the reader is `apps/api/src/geo/manifest.ts`.
 * What lives here is the shape and the hash, so the two cannot disagree about
 * either.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cityBboxSchema, type CityBbox } from '../geo/schemas.js';

/** Bumped when the manifest's shape changes, so an old file is rejected loudly. */
export const GEO_MANIFEST_VERSION = 2;

/**
 * The epoch used when there is no manifest at all — a clone that has never run
 * `pnpm bootstrap`. Cache keys still need a stable prefix, and pretending an
 * unbuilt tree has an epoch would make the first real build look like a
 * no-change rebuild.
 */
export const GEO_EPOCH_UNBUILT = 'unbuilt';

/** How many hex characters of a sha256 a hash is truncated to. */
const HASH_LENGTH = 12;

export const geoSourceSchema = z.object({
  /** File name inside `.osm-cache/`, e.g. `eastern-zone-latest.osm.pbf`. */
  name: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  /** Full sha256 of the download; the epoch truncates, this does not. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export type GeoSource = z.infer<typeof geoSourceSchema>;

export const geoManifestCitySchema = z.object({
  slug: z.string().min(1),
  zone: z.string().min(1),
  /** The administrative bbox: what "is this locality in its city" validates against. */
  bbox: cityBboxSchema,
  /** What `osmium extract` actually cut. Padded by BBOX_PAD_KM — see D47. */
  paddedBbox: cityBboxSchema,
});

export type GeoManifestCity = z.infer<typeof geoManifestCitySchema>;

export const geoManifestSchema = z.object({
  version: z.literal(GEO_MANIFEST_VERSION),
  /** Short hash of everything below. Prefixes every derived cache key. */
  epoch: z.string().min(1),
  /** Short hash of the city config alone, so config and source drift are separable. */
  configHash: z.string().min(1),
  generatedAt: z.string(),
  cities: z.array(geoManifestCitySchema).min(1),
  sources: z.array(geoSourceSchema),
  /** The merged extract every downstream service is built from. */
  merged: geoSourceSchema,
});

export type GeoManifest = z.infer<typeof geoManifestSchema>;

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, HASH_LENGTH);
}

/**
 * Hash of the parts of the city config that decide what the artifacts contain.
 *
 * Deliberately NOT the whole city record. Transit fares and locality names are
 * seed data: changing one does not invalidate a routing graph, and hashing them
 * here would raise a stale-artifact alarm that a rebuild could not clear.
 */
export function computeGeoConfigHash(
  cities: readonly { slug: string; zone: string; bbox: CityBbox; paddedBbox: CityBbox }[],
): string {
  const flat = (bbox: CityBbox): number[] => [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat];

  const canonical = [...cities]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((city) => ({
      slug: city.slug,
      zone: city.zone,
      bbox: flat(city.bbox),
      // The padded box is the one artifacts are cut from, so it is the one that
      // decides whether they are stale. The unpadded box is hashed too: it
      // drives city assignment and locality validation, and a change to it
      // without a rebuild would leave the manifest describing bounds nothing
      // was cut with.
      paddedBbox: flat(city.paddedBbox),
    }));

  return shortHash(JSON.stringify(canonical));
}

/**
 * The epoch: the config hash plus every source checksum.
 *
 * Sources are sorted by name so the order Geofabrik files happen to be listed
 * in cannot change the epoch — an epoch that moves without the data moving
 * would throw away a warm cache for nothing.
 */
export function computeGeoEpoch(input: {
  configHash: string;
  sources: readonly GeoSource[];
}): string {
  const canonical = [...input.sources]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((source) => `${source.name}:${source.sha256}`);

  return shortHash([input.configHash, ...canonical].join('|'));
}
