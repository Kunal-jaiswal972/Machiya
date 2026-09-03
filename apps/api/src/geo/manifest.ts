import { readFileSync } from 'node:fs';
import { GEO_EPOCH_UNBUILT, geoManifestSchema, type GeoManifest } from '@machiya/shared/cities';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * The geo epoch, read once at boot from `osm-data/manifest.json`.
 *
 * Every cache key for a route, a POI set or a geocode is prefixed with it,
 * because all three are **derived from the OSM artifacts** — the OSRM graphs,
 * the Nominatim database and the Overpass database, all built from one merged
 * extract. A cached route belongs to the graph that produced it: after a
 * re-cut with different bounds, the same key names a different answer.
 *
 * Prefixing means a rebuild changes the epoch and every derived entry becomes
 * unreachable, with nobody having to remember to flush anything and no risk of
 * one machine's partial rebuild serving another machine's geometry. The
 * orphaned entries expire on their own TTL. See DECISIONS.md D46.
 *
 * Read synchronously, and read once: it is a few hundred bytes at startup, and
 * an epoch that could change under a running process would split one request's
 * reads from its writes.
 */
function load(): GeoManifest | null {
  try {
    const raw = readFileSync(env.GEO_MANIFEST_PATH, 'utf8');
    const manifest = geoManifestSchema.parse(JSON.parse(raw));

    logger.info(
      {
        epoch: manifest.epoch,
        configHash: manifest.configHash,
        cities: manifest.cities.map((city) => city.slug),
        generatedAt: manifest.generatedAt,
      },
      'geo artifact manifest loaded',
    );

    return manifest;
  } catch (error) {
    // Not fatal. The core stack is usable before `pnpm bootstrap` has ever run
    // (D6), and the geo providers already degrade when their services are
    // absent. What must not happen is a silent fallback, so this is a warning
    // with the path in it.
    logger.warn(
      { err: error, path: env.GEO_MANIFEST_PATH },
      'no usable geo artifact manifest; derived caches will use the "unbuilt" epoch',
    );
    return null;
  }
}

const manifest = load();

/** The manifest, or null when the artifacts have never been built here. */
export function geoManifest(): GeoManifest | null {
  return manifest;
}

export function geoEpoch(): string {
  return manifest?.epoch ?? GEO_EPOCH_UNBUILT;
}

/**
 * Builds a Redis key for something derived from the OSM artifacts.
 *
 * Use it for routes, POIs and geocodes. Do NOT use it for anything else — the
 * view-dedupe key is the counter-example: it has nothing to do with OSM data,
 * and prefixing it would reset every dedupe window on a rebuild.
 */
export function geoCacheKey(...parts: (string | number)[]): string {
  return [geoEpoch(), ...parts.map(String)].join(':');
}
