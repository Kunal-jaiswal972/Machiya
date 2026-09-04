import { readFileSync } from 'node:fs';
import {
  CITIES,
  GEO_EPOCH_UNBUILT,
  computeGeoConfigHash,
  geoManifestSchema,
  type GeoManifest,
} from '@machiya/shared/cities';
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

export type GeoArtifactState = 'ok' | 'unbuilt' | 'stale';

export interface GeoArtifactStatus {
  ok: boolean;
  state: GeoArtifactState;
  reason: string;
  epoch: string;
  /** What the running config hashes to, whatever the manifest says. */
  configHash: string;
}

/**
 * Whether the artifacts on this machine describe the city config this process
 * is running.
 *
 * The failure it exists for: a fourth city added to `CITIES` while the OSRM
 * graphs, the Nominatim database and the Overpass database still hold three.
 * Every page then renders, every probe passes, and the new city geocodes and
 * routes to nowhere. So the divergence is loud at boot and it fails
 * `/health/geo` — which is deliberately NOT `/health`: a fresh clone has no
 * artifacts at all (D6), and making the core stack unhealthy until someone
 * runs `pnpm bootstrap` would be worse than the bug. See DECISIONS.md D51.
 */
export function geoArtifactStatus(): GeoArtifactStatus {
  const configHash = computeGeoConfigHash(CITIES);

  if (!manifest) {
    return {
      ok: false,
      state: 'unbuilt',
      reason: `no artifact manifest at ${env.GEO_MANIFEST_PATH} — run pnpm bootstrap`,
      epoch: GEO_EPOCH_UNBUILT,
      configHash,
    };
  }

  if (manifest.configHash !== configHash) {
    const described = manifest.cities.map((city) => city.slug);
    const configured = CITIES.map((city) => city.slug);
    const added = configured.filter((slug) => !described.includes(slug));
    const removed = described.filter((slug) => !configured.includes(slug));

    return {
      ok: false,
      state: 'stale',
      reason: [
        `artifacts describe config ${manifest.configHash} but this process is running ${configHash}`,
        added.length > 0 ? `cities added since the build: ${added.join(', ')}` : '',
        removed.length > 0 ? `cities removed since the build: ${removed.join(', ')}` : '',
        'run pnpm geo:status for what to rebuild',
      ]
        .filter(Boolean)
        .join('; '),
      epoch: manifest.epoch,
      configHash,
    };
  }

  return {
    ok: true,
    state: 'ok',
    reason: `${String(manifest.cities.length)} cities, built ${manifest.generatedAt}`,
    epoch: manifest.epoch,
    configHash,
  };
}

/**
 * Said once, at boot, at a level that matches the consequence. A stale artifact
 * set is not a warning about tidiness — it is a city that will silently return
 * nothing.
 */
const bootStatus = geoArtifactStatus();

if (bootStatus.state === 'stale') {
  logger.error(
    { state: bootStatus.state, reason: bootStatus.reason, epoch: bootStatus.epoch },
    'OSM ARTIFACTS ARE STALE: a configured city may geocode and route to nowhere while looking healthy',
  );
} else if (bootStatus.state === 'unbuilt') {
  logger.warn(
    { reason: bootStatus.reason },
    'OSM artifacts have never been built here; routing, geocoding and POIs will all degrade',
  );
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
