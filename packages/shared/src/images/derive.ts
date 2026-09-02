import { fileTypeFromBuffer } from 'file-type';
import sharp, { type Metadata } from 'sharp';

/**
 * Image validation and derivation. Pure: bytes in, bytes out, no storage and no
 * database, so it is unit-testable on its own.
 *
 * Only apps/worker imports this. `sharp` is a peer dependency of this package
 * precisely so that importing @machiya/shared from the browser app can never
 * drag a native libvips binary into the web bundle.
 */

/** Magic-byte types we accept. The declared content type is never trusted. */
export const ACCEPTED_IMAGE_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const;

export const MAX_PIXELS_PER_AXIS = 12_000;

export const VARIANT_SIZES = [
  { name: 'thumb', width: 320 },
  { name: 'card', width: 800 },
  { name: 'full', width: 1600 },
] as const;

export type VariantName = (typeof VARIANT_SIZES)[number]['name'];

/** A rejection is the image's fault and must not be retried. */
export class ImageRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ImageRejected';
  }
}

export interface DerivedVariant {
  size: VariantName;
  extension: 'webp' | 'jpg';
  contentType: 'image/webp' | 'image/jpeg';
  body: Buffer;
}

export interface DeriveResult {
  width: number;
  height: number;
  /** #rrggbb, for the placeholder behind a loading photo. */
  dominantColor: string;
  /** 16px-wide WebP as a data URI, so a gallery never flashes empty. */
  lqip: string;
  variants: DerivedVariant[];
}

function hex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0');
}

/** Whether this sharp build can actually decode HEIC. Prebuilds usually cannot. */
function canDecodeHeic(): boolean {
  return sharp.format.heif?.input?.buffer === true;
}

/**
 * Validates the real bytes, then derives every variant.
 *
 * The order matters: magic bytes first, because the upload arrived through a
 * presigned URL and its declared content type and file extension are both
 * attacker-controlled. Then sharp's own decode, which is what catches a file
 * whose header says JPEG but whose body is not.
 */
export async function validateAndDerive(bytes: Buffer): Promise<DeriveResult> {
  const sniffed = await fileTypeFromBuffer(bytes);

  if (!sniffed) {
    throw new ImageRejected('That file is not a recognisable image');
  }

  if (!ACCEPTED_IMAGE_MIMES.includes(sniffed.mime as (typeof ACCEPTED_IMAGE_MIMES)[number])) {
    throw new ImageRejected(`Images must be JPEG, PNG, WebP or HEIC — that one is ${sniffed.mime}`);
  }

  if (sniffed.mime === 'image/heic' && !canDecodeHeic()) {
    throw new ImageRejected(
      'This server cannot read HEIC. Export the photo as JPEG and upload that instead.',
    );
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(bytes).metadata();
  } catch {
    throw new ImageRejected('That image could not be decoded');
  }

  const { width, height, pages } = metadata;

  if (!width || !height) {
    throw new ImageRejected('That image has no readable dimensions');
  }

  if (width > MAX_PIXELS_PER_AXIS || height > MAX_PIXELS_PER_AXIS) {
    throw new ImageRejected(
      `That image is ${width}x${height}; the limit is ${MAX_PIXELS_PER_AXIS}px on a side`,
    );
  }

  // An animated WebP or GIF would be resized to a single frame silently, and a
  // multi-page TIFF is a decompression risk. Reject rather than mangle.
  if (typeof pages === 'number' && pages > 1) {
    throw new ImageRejected('Animated images are not supported — upload a still photo');
  }

  // .rotate() with no argument applies the EXIF orientation and then drops it.
  // sharp writes no metadata unless asked, so GPS coordinates and camera
  // serials in a phone photo never reach the bucket — which matters when the
  // subject is somebody's home.
  const upright = sharp(bytes).rotate();

  const stats = await upright.clone().stats();
  const dominantColor = `#${hex(stats.dominant.r)}${hex(stats.dominant.g)}${hex(stats.dominant.b)}`;

  const lqipBuffer = await upright.clone().resize({ width: 16 }).webp({ quality: 40 }).toBuffer();
  const lqip = `data:image/webp;base64,${lqipBuffer.toString('base64')}`;

  const variants: DerivedVariant[] = [];

  for (const size of VARIANT_SIZES) {
    const resized = upright.clone().resize({ width: size.width, withoutEnlargement: true });

    const [webp, jpeg] = await Promise.all([
      resized.clone().webp({ quality: 78 }).toBuffer(),
      resized.clone().jpeg({ quality: 82, progressive: true, mozjpeg: true }).toBuffer(),
    ]);

    variants.push(
      { size: size.name, extension: 'webp', contentType: 'image/webp', body: webp },
      { size: size.name, extension: 'jpg', contentType: 'image/jpeg', body: jpeg },
    );
  }

  return { width, height, dominantColor, lqip, variants };
}
