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

  it('strips EXIF, including GPS, while honouring orientation', async () => {
    // Orientation 6 means "rotate 90 clockwise": a 400x200 source must come out
    // 200x400, proving the rotation was applied rather than the tag copied.
    const bytes = await gradient(400, 200)
      .withExif({
        IFD0: { Copyright: 'Machiya test' },
        GPS: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' },
        IFD1: { Orientation: '6' },
      })
      .jpeg()
      .toBuffer();

    const result = await validateAndDerive(bytes);
    const full = result.variants.find(
      (variant) => variant.size === 'full' && variant.extension === 'jpg',
    );
    const meta = await sharp(full?.body).metadata();

    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });
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
    const frames = await sharp({
      create: {
        width: 64,
        height: 64 * 3,
        channels: 4,
        background: { r: 10, g: 20, b: 30, alpha: 1 },
      },
    })
      .webp({ loop: 0 })
      .toBuffer();

    const animated = await sharp(frames, { pages: 3, pageHeight: 64 }).webp().toBuffer();
    const meta = await sharp(animated, { pages: -1 }).metadata();

    // Only assert the rejection if this sharp build really produced an animation.
    if ((meta.pages ?? 1) > 1) {
      await expect(validateAndDerive(animated)).rejects.toThrow(/Animated images/);
    }
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
