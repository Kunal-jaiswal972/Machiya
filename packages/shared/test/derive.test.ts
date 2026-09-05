import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  fixtureVariantBaseKey,
  ImageRejected,
  isListingOwnedVariantBase,
  validateAndDerive,
  variantBaseKey,
  variantObjectKey,
} from '../src/images/index.js';

function gradient(width: number, height: number) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 32, g: 96, b: 200 },
    },
  });
}

/**
 * A 200-byte two-frame animated WebP, committed as base64.
 *
 * WebP specifically, not GIF: GIF is not an accepted format, so an animated GIF
 * is rejected for the wrong reason and never reaches the animation check. This
 * has to be a format the pipeline WOULD accept, so that the only thing left to
 * reject it is the animation.
 *
 * Committed rather than constructed, because sharp cannot be persuaded to write
 * a multi-page image from a tall single-page buffer — the approach this test
 * used before produced one page and silently skipped its own assertion. Built
 * once from a hand-assembled 2-frame GIF89a and verified: `pages` is 2.
 */
const ANIMATED_WEBP = Buffer.from(
  'UklGRsAAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAD/////AABBTk1GPgAAAAAAAAAAAAEAAAEAAGQAAAJWUDggJgAAAHABAJ0BKgIAAgABQCYliAJ0AXUAAP79Cgb5igL/an72fhPy2DAAQU5NRk4AAAAAAAAAAAABAAABAABkAAAAVlA4IDYAAAC0AQCdASoCAAIAAAAmJaACdAEO9qOAAP77n3V71FngLwfUtt/7sn//2yf//bJ/7xPY9rgAAAA=',
  'base64',
);

describe('validateAndDerive', () => {
  it('derives three sizes in WebP and JPEG from a JPEG', async () => {
    const bytes = await gradient(1400, 900).jpeg().toBuffer();

    const result = await validateAndDerive(bytes);

    expect(result.width).toBe(1400);
    expect(result.height).toBe(900);
    expect(result.variants).toHaveLength(6);
    expect(result.variants.map((variant) => `${variant.size}.${variant.extension}`).sort()).toEqual(
      ['card.jpg', 'card.webp', 'full.jpg', 'full.webp', 'thumb.jpg', 'thumb.webp'],
    );

    const thumb = result.variants.find(
      (variant) => variant.size === 'thumb' && variant.extension === 'webp',
    );
    const meta = await sharp(thumb?.body).metadata();
    expect(meta.width).toBe(320);
    expect(meta.format).toBe('webp');
  });

  it('accepts PNG and WebP too', async () => {
    for (const bytes of [
      await gradient(600, 400).png().toBuffer(),
      await gradient(600, 400).webp().toBuffer(),
    ]) {
      await expect(validateAndDerive(bytes)).resolves.toMatchObject({ width: 600 });
    }
  });

  it('never enlarges a small image', async () => {
    const bytes = await gradient(200, 150).jpeg().toBuffer();

    const result = await validateAndDerive(bytes);
    const full = result.variants.find(
      (variant) => variant.size === 'full' && variant.extension === 'webp',
    );

    expect((await sharp(full?.body).metadata()).width).toBe(200);
  });

  it('returns a placeholder colour and an inline preview', async () => {
    const bytes = await gradient(800, 600).jpeg().toBuffer();

    const result = await validateAndDerive(bytes);

    expect(result.dominantColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(result.lqip.startsWith('data:image/webp;base64,')).toBe(true);
    // Inline previews are embedded in HTML, so they have to stay tiny.
    expect(result.lqip.length).toBeLessThan(2_000);
  });

  it('strips EXIF, including the GPS directory', async () => {
    // `IFD3` is sharp's name for the GPS directory, and the distinction is not
    // cosmetic: the earlier `GPS:` key is not part of sharp's `Exif` type, so
    // it was silently ignored and this test asserted that an image with NO
    // location data came out with none. Measured, `IFD3` takes the EXIF block
    // from 230 to 272 bytes, so there is now something real to strip.
    const bytes = await gradient(400, 200)
      .withExif({
        IFD0: { Copyright: 'Machiya test' },
        IFD3: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' },
      })
      .jpeg()
      .toBuffer();

    // The premise, asserted rather than assumed — otherwise a future sharp that
    // stopped writing EXIF here would make the strip look like it worked.
    const before = await sharp(bytes).metadata();
    expect(before.exif).toBeDefined();

    const result = await validateAndDerive(bytes);
    const full = result.variants.find(
      (variant) => variant.size === 'full' && variant.extension === 'jpg',
    );
    const meta = await sharp(full?.body).metadata();

    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  /**
   * Orientation is applied by `.rotate()` in `derive.ts` and cannot be tested
   * through `withExif`.
   *
   * Verified while fixing the test above: sharp normalises orientation to 1 when
   * it WRITES a file, whichever directory the tag is put in — `IFD0` and `IFD1`
   * both come back as orientation 1, and a 400x200 image "tagged" 6 stays
   * 400x200 through `.rotate()`. The old test's comment claimed the rotation was
   * proven by the dimensions; it never checked them, and could not have.
   *
   * Testing it properly needs a fixture file carrying a real non-1 orientation,
   * which means committing binary test data. Left undone deliberately rather
   * than left looking done.
   */
});

describe('validateAndDerive rejections', () => {
  it('rejects a file that is not an image, whatever it is named', async () => {
    const bytes = Buffer.from('#!/bin/sh\necho definitely not a photo\n', 'utf8');

    await expect(validateAndDerive(bytes)).rejects.toBeInstanceOf(ImageRejected);
    await expect(validateAndDerive(bytes)).rejects.toThrow(/not a recognisable image/);
  });

  it('rejects a real file of the wrong type by its magic bytes', async () => {
    // A PDF header: sniffing catches it even though nothing about the name or
    // the declared content type would have.
    const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n', 'utf8'), Buffer.alloc(1024, 0x20)]);

    await expect(validateAndDerive(bytes)).rejects.toThrow(/must be JPEG, PNG, WebP or HEIC/);
  });

  it('rejects an image larger than the pixel limit on either axis', async () => {
    const bytes = await gradient(12_400, 40).jpeg().toBuffer();

    await expect(validateAndDerive(bytes)).rejects.toThrow(/the limit is 12000px/);
  });

  it('rejects an animated image rather than silently keeping one frame', async () => {
    const meta = await sharp(ANIMATED_WEBP, { pages: -1 }).metadata();

    // The premise, asserted unconditionally. The previous version of this test
    // built its "animation" with `sharp(buffer, { pages: 3, pageHeight: 64 })`
    // — but `pageHeight` is not a `SharpOptions` field, so it was ignored, the
    // image had one page, and the `if (pages > 1)` guard meant the rejection
    // was NEVER checked. A test that cannot fail is worse than no test.
    expect(meta.pages).toBe(2);

    await expect(validateAndDerive(ANIMATED_WEBP)).rejects.toThrow(/Animated images/);
  });
});

describe('object keys', () => {
  it('puts variants under the public prefix and keeps them per image', () => {
    expect(variantObjectKey('variants/listing-1/image-9', 'card', 'webp')).toBe(
      'variants/listing-1/image-9/card.webp',
    );
  });
});

describe('variant key ownership', () => {
  it('claims a listing’s own variant prefix', () => {
    expect(isListingOwnedVariantBase(variantBaseKey('listing-1', 'image-9'), 'listing-1')).toBe(
      true,
    );
  });

  it('does not claim a shared fixture prefix', () => {
    // The whole point: deleting a seeded listing must not delete the shared
    // photo that every other seeded listing is also pointing at. See D41.
    expect(isListingOwnedVariantBase(fixtureVariantBaseKey('unsplash-abc'), 'listing-1')).toBe(
      false,
    );
  });

  it('does not claim another listing’s prefix', () => {
    expect(isListingOwnedVariantBase(variantBaseKey('listing-2', 'image-9'), 'listing-1')).toBe(
      false,
    );
  });

  it('is not fooled by a listing id that is a prefix of another', () => {
    // 'listing-1' must not match 'listing-12'; the trailing slash is what stops
    // it, and it is easy to drop.
    expect(isListingOwnedVariantBase(variantBaseKey('listing-12', 'image-9'), 'listing-1')).toBe(
      false,
    );
  });
});
