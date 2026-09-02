/**
 * Object key layout. Two prefixes with different access policies:
 *
 *   originals/{listingId}/{imageId}.{ext}          PRIVATE — never served
 *   variants/{listingId}/{imageId}/{size}.{ext}    public read
 *
 * Uploads land in `originals/` straight from the browser and are not known to be
 * images until the worker decodes them, so nothing under that prefix may ever be
 * publicly readable. See DECISIONS.md D35.
 */
export const ORIGINALS_PREFIX = 'originals';
export const VARIANTS_PREFIX = 'variants';

export function originalObjectKey(listingId: string, imageId: string, extension: string): string {
  return `${ORIGINALS_PREFIX}/${listingId}/${imageId}.${extension}`;
}

export function variantObjectKey(
  listingId: string,
  imageId: string,
  size: string,
  extension: string,
): string {
  return `${VARIANTS_PREFIX}/${listingId}/${imageId}/${size}.${extension}`;
}

export function variantPrefixFor(listingId: string, imageId?: string): string {
  return imageId
    ? `${VARIANTS_PREFIX}/${listingId}/${imageId}/`
    : `${VARIANTS_PREFIX}/${listingId}/`;
}
