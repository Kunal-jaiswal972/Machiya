/**
 * The city configuration and the OSM artifacts cut from it.
 *
 * A **separate subpath** (`@machiya/shared/cities`) rather than part of the
 * package index, for the same reason `@machiya/shared/images` is: the module
 * graph reaches `node:crypto`, and pulling it into the browser app would break
 * the Vite build. Nothing in the web app needs the city config — it reads
 * `/api/cities` — so the boundary costs nothing.
 */
export * from './bbox.js';
export * from './boundaries.generated.js';
export * from './config.js';
export * from './fuel-sources.js';
export * from './manifest.js';
export * from './validate.js';
