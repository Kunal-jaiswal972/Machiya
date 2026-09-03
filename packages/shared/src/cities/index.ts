/**
 * The city configuration and the OSM artifacts cut from it.
 *
 * A **separate subpath** (`@machiya/shared/cities`) rather than part of the
 * package index, for the same reason `@machiya/shared/images` is: this module
 * imports `node:crypto`, and pulling it into the browser app would break the
 * Vite build. Nothing in the web app needs the city config — it reads
 * `/api/cities` — so the boundary costs nothing.
 */
export * from './manifest.js';
