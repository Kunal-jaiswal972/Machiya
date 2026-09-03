/**
 * Object key layout. Two prefixes with different access policies:
 *
 *   originals/{listingId}/{imageId}.{ext}          PRIVATE — never served
 *   variants/{listingId}/{imageId}/{size}.{ext}    public read
 *
 * Uploads land in `originals/` straight from the browser and are not known to be
 * images until the worker decodes them, so nothing under that prefix may ever be
 * publicly readable. See DECISIONS.md D35.
 *
 * A row's variant location is STORED on the row (`ListingImage.variantBaseKey`)
 * rather than recomputed from ids at every call site. That is what lets seeded
 * listings share one copy of a photo under `variants/fixtures/{photoId}/`
 * instead of writing 1,200 objects of identical bytes — see D41 — and it means
 * the URL for an image has exactly one source of truth.
 */
export const ORIGINALS_PREFIX = 'originals';
export const VARIANTS_PREFIX = 'variants';

/** Shared, seed-owned photos. Never written by an upload. */
export const FIXTURES_SEGMENT = 'fixtures';

export function originalObjectKey(listingId: string, imageId: string, extension: string): string {
  return `${ORIGINALS_PREFIX}/${listingId}/${imageId}.${extension}`;
}

/**
 * Where an uploaded image's variants live. Known at row-creation time, because
 * both ids are, which is why the column can be NOT NULL.
 */
export function variantBaseKey(listingId: string, imageId: string): string {
  return `${VARIANTS_PREFIX}/${listingId}/${imageId}`;
}

/** Where a shared seed photo's variants live. */
export function fixtureVariantBaseKey(photoId: string): string {
  return `${VARIANTS_PREFIX}/${FIXTURES_SEGMENT}/${photoId}`;
}

export function variantObjectKey(baseKey: string, size: string, extension: string): string {
  return `${baseKey}/${size}.${extension}`;
}

/**
 * Whether a variant base key belongs to this listing alone.
 *
 * Deleting a listing deletes its objects, and a shared fixture key must survive
 * that — otherwise removing one seeded listing blanks the galleries of every
 * other listing using the same photo. This is the whole guard, and it is called
 * from the two places that delete.
 */
export function isListingOwnedVariantBase(baseKey: string, listingId: string): boolean {
  return baseKey.startsWith(`${VARIANTS_PREFIX}/${listingId}/`);
}

export function variantPrefixFor(listingId: string, imageId?: string): string {
  return imageId
    ? `${VARIANTS_PREFIX}/${listingId}/${imageId}/`
    : `${VARIANTS_PREFIX}/${listingId}/`;
}
