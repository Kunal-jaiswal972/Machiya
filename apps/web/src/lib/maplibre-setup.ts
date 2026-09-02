import { setWorkerUrl } from 'maplibre-gl';

/**
 * Point maplibre at the worker copied into `public/maplibre` by
 * `scripts/sync-maplibre-worker.mjs`.
 *
 * Without this, a production build silently never fetches a single vector tile.
 * See the comment in that script for the full failure mode. This module must be
 * imported before the first Map is constructed.
 */
setWorkerUrl(`${import.meta.env.BASE_URL}maplibre/maplibre-gl-worker.mjs`);
