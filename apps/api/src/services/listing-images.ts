import { randomUUID } from 'node:crypto';
import { prisma } from '@machiya/db';
import {
  MAX_IMAGES_PER_LISTING,
  imageReorderSchema,
  imageUploadRequestSchema,
  type ImageUploadTicket,
  type ListingImageView,
} from '@machiya/shared';
import { originalObjectKey, variantObjectKey, VARIANT_SIZES } from '@machiya/shared/images';
import { HttpError } from '../middleware/error-handler.js';
import { assertOwnership, type RequestSession } from '../middleware/require-auth.js';
import {
  UPLOAD_URL_TTL_SECONDS,
  createUploadTicket,
  deleteObject,
  deleteObjects,
  headObject,
  publicVariantUrl,
} from '../lib/storage.js';
import { enqueueImageProcessing } from '../lib/queues.js';

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

interface ImageRow {
  id: string;
  status: 'PENDING' | 'READY' | 'REJECTED' | 'FAILED';
  width: number;
  height: number;
  sortOrder: number;
  isCover: boolean;
  failureReason: string | null;
  dominantColor: string | null;
  lqip: string | null;
}

export function toImageView(image: ImageRow, listingId: string): ListingImageView {
  return {
    id: image.id,
    status: image.status,
    width: image.width,
    height: image.height,
    sortOrder: image.sortOrder,
    isCover: image.isCover,
    failureReason: image.failureReason,
    dominantColor: image.dominantColor,
    lqip: image.lqip,
    // Only READY images have public bytes. The original is in a private prefix.
    urls:
      image.status === 'READY'
        ? {
            thumb: publicVariantUrl(variantObjectKey(listingId, image.id, 'thumb', 'webp')),
            card: publicVariantUrl(variantObjectKey(listingId, image.id, 'card', 'webp')),
            full: publicVariantUrl(variantObjectKey(listingId, image.id, 'full', 'webp')),
          }
        : null,
  };
}

async function assertOwnsListing(session: RequestSession, listingId: string): Promise<void> {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: { ownerId: true },
  });

  if (!listing) {
    throw new HttpError(404, 'listing_not_found', 'No such listing');
  }

  assertOwnership(session, listing.ownerId);
}

/**
 * Issues a presigned upload and records a PENDING row.
 *
 * The row exists before the bytes do, deliberately: an abandoned upload then
 * shows up as a PENDING image the cleanup job can sweep, rather than as an
 * orphan object nobody can find. The declared content type only picks the file
 * extension — the worker decides what the file actually is.
 */
export async function requestImageUpload(
  session: RequestSession,
  listingId: string,
  body: unknown,
): Promise<ImageUploadTicket> {
  await assertOwnsListing(session, listingId);

  const { contentType } = imageUploadRequestSchema.parse(body);

  const existing = await prisma.listingImage.count({ where: { listingId } });
  if (existing >= MAX_IMAGES_PER_LISTING) {
    throw new HttpError(
      409,
      'too_many_images',
      `A listing can have at most ${MAX_IMAGES_PER_LISTING} photos`,
    );
  }

  const imageId = randomUUID();
  const extension = EXTENSION_BY_TYPE[contentType] ?? 'jpg';
  const objectKey = originalObjectKey(listingId, imageId, extension);

  const ticket = await createUploadTicket({ objectKey, contentType });

  await prisma.listingImage.create({
    data: {
      id: imageId,
      listingId,
      objectKey,
      status: 'PENDING',
      width: 0,
      height: 0,
      sortOrder: existing,
      isCover: existing === 0,
    },
  });

  return {
    imageId,
    objectKey,
    uploadUrl: ticket.uploadUrl,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    fields: ticket.fields,
  };
}

/**
 * Called after the client's upload succeeds. Confirms the object is really
 * there, then queues derivation. Reads no image bytes.
 *
 * Idempotent by design: an image already READY returns as-is, and the queue job
 * id is the image id, so a double-tap or a retried request collapses onto one
 * job instead of resizing the same photo twice.
 */
export async function markImageUploaded(
  session: RequestSession,
  listingId: string,
  imageId: string,
): Promise<ListingImageView> {
  await assertOwnsListing(session, listingId);

  const image = await prisma.listingImage.findFirst({ where: { id: imageId, listingId } });

  if (!image) {
    throw new HttpError(404, 'image_not_found', 'No such image on this listing');
  }

  if (image.status === 'READY') {
    return toImageView(image, listingId);
  }

  if (!image.objectKey) {
    throw new HttpError(409, 'upload_missing', 'That upload is no longer available');
  }

  const head = await headObject(image.objectKey);

  if (!head.exists) {
    // The client said it uploaded and it did not. Queueing would just burn
    // three retries on a missing object.
    throw new HttpError(409, 'upload_missing', 'That upload did not arrive — try again');
  }

  await enqueueImageProcessing({ listingId, imageId, objectKey: image.objectKey });

  const updated = await prisma.listingImage.update({
    where: { id: imageId },
    data: { status: 'PENDING', failureReason: null },
  });

  return toImageView(updated, listingId);
}

/** Reorder, and set the cover from the new first position. Metadata only. */
export async function reorderImages(
  session: RequestSession,
  listingId: string,
  body: unknown,
): Promise<ListingImageView[]> {
  await assertOwnsListing(session, listingId);

  const { imageIds } = imageReorderSchema.parse(body);

  const owned = await prisma.listingImage.findMany({
    where: { listingId },
    select: { id: true },
  });
  const ownedIds = new Set(owned.map((image) => image.id));

  // Every id must belong to THIS listing, or a reorder becomes a way to probe
  // and mutate another listing's images.
  if (imageIds.some((id) => !ownedIds.has(id))) {
    throw new HttpError(400, 'image_not_found', 'Those images are not on this listing');
  }

  if (imageIds.length !== owned.length) {
    throw new HttpError(400, 'incomplete_order', 'Send every image id, in the order you want');
  }

  // Nothing here re-runs the pipeline: cover and order are pure metadata.
  await prisma.$transaction(
    imageIds.map((id, index) =>
      prisma.listingImage.update({
        where: { id },
        data: { sortOrder: index, isCover: index === 0 },
      }),
    ),
  );

  const images = await prisma.listingImage.findMany({
    where: { listingId },
    orderBy: { sortOrder: 'asc' },
  });

  return images.map((image) => toImageView(image, listingId));
}

/** Original plus every derivative of one image. */
function objectKeysFor(listingId: string, imageId: string, originalKey: string | null): string[] {
  return [
    ...(originalKey ? [originalKey] : []),
    ...VARIANT_SIZES.flatMap((size) => [
      variantObjectKey(listingId, imageId, size.name, 'webp'),
      variantObjectKey(listingId, imageId, size.name, 'jpg'),
    ]),
  ];
}

export async function deleteImage(
  session: RequestSession,
  listingId: string,
  imageId: string,
): Promise<{ id: string }> {
  await assertOwnsListing(session, listingId);

  const image = await prisma.listingImage.findFirst({ where: { id: imageId, listingId } });

  if (!image) {
    throw new HttpError(404, 'image_not_found', 'No such image on this listing');
  }

  await prisma.listingImage.delete({ where: { id: imageId } });
  await deleteObjects(objectKeysFor(listingId, imageId, image.objectKey));

  // Keep sortOrder contiguous and make sure a cover still exists.
  const remaining = await prisma.listingImage.findMany({
    where: { listingId },
    orderBy: { sortOrder: 'asc' },
    select: { id: true },
  });

  if (remaining.length > 0) {
    await prisma.$transaction(
      remaining.map((row, index) =>
        prisma.listingImage.update({
          where: { id: row.id },
          data: { sortOrder: index, isCover: index === 0 },
        }),
      ),
    );
  }

  return { id: imageId };
}

/** Every object a listing owns, for cleanup when the listing itself is deleted. */
export async function listingObjectKeys(listingId: string): Promise<string[]> {
  const images = await prisma.listingImage.findMany({
    where: { listingId },
    select: { id: true, objectKey: true },
  });

  return images.flatMap((image) => objectKeysFor(listingId, image.id, image.objectKey));
}

export { deleteObject };
