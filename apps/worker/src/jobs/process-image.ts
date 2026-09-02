import { prisma } from '@machiya/db';
import { ImageRejected, validateAndDerive, variantObjectKey } from '@machiya/shared/images';
import type { Job } from 'bullmq';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { deleteObjects, getObjectBytes, putObjectBytes } from '../lib/storage.js';

export interface ProcessImageJob {
  listingId: string;
  imageId: string;
  objectKey: string;
}

/**
 * Validates one uploaded original and writes its derivatives.
 *
 * This runs in the worker, not the API, for four reasons: the API never touches
 * image bytes at all (uploads go browser-to-storage), libvips spikes CPU and RSS
 * in a way that should be scalable and restartable on its own, sharp's native
 * binaries stay out of the API image, and BullMQ already gives us retries and
 * backoff. See DECISIONS.md D37.
 *
 * Failure has two distinct shapes, and conflating them would be a bug:
 *  - ImageRejected: the file is the problem. Terminal. Mark REJECTED, delete the
 *    original, and do NOT retry — three attempts at the same corrupt JPEG is
 *    three times the work for the same answer.
 *  - anything else: our problem (storage blip, OOM). Rethrow so BullMQ retries.
 */
export async function processImageJob(job: Job<ProcessImageJob>): Promise<void> {
  const { listingId, imageId, objectKey } = job.data;
  const log = logger.child({ listingId, imageId, attempt: job.attemptsMade + 1 });

  const image = await prisma.listingImage.findUnique({ where: { id: imageId } });

  if (!image) {
    // The listing or image was deleted while the job waited. Not an error.
    log.info('image row is gone; dropping job');
    await deleteObjects([objectKey]);
    return;
  }

  if (image.status === 'READY') {
    log.info('image already processed; job is a no-op');
    return;
  }

  let derived;
  try {
    const bytes = await getObjectBytes(objectKey);
    derived = await validateAndDerive(bytes);
  } catch (error) {
    if (error instanceof ImageRejected) {
      log.warn({ reason: error.reason }, 'image rejected');

      await prisma.listingImage.update({
        where: { id: imageId },
        data: {
          status: 'REJECTED',
          failureReason: error.reason,
          objectKey: null,
          processedAt: new Date(),
        },
      });

      await deleteObjects([objectKey]);
      return;
    }

    // Transient: let BullMQ back off and try again.
    log.error({ err: error }, 'image processing failed; will retry');
    throw error;
  }

  await Promise.all(
    derived.variants.map((variant) =>
      putObjectBytes({
        objectKey: variantObjectKey(listingId, imageId, variant.size, variant.extension),
        body: variant.body,
        contentType: variant.contentType,
      }),
    ),
  );

  await prisma.listingImage.update({
    where: { id: imageId },
    data: {
      status: 'READY',
      width: derived.width,
      height: derived.height,
      dominantColor: derived.dominantColor,
      lqip: derived.lqip,
      failureReason: null,
      processedAt: new Date(),
      // The original is private and nothing serves from it, so it goes unless
      // explicitly kept.
      objectKey: env.KEEP_ORIGINALS ? objectKey : null,
    },
  });

  if (!env.KEEP_ORIGINALS) {
    await deleteObjects([objectKey]);
  }

  log.info(
    { width: derived.width, height: derived.height, variants: derived.variants.length },
    'image ready',
  );
}

/**
 * Records a terminal failure after BullMQ has exhausted its retries, so the
 * wizard can show the user something better than a permanent spinner.
 */
export async function markImageFailed(imageId: string, reason: string): Promise<void> {
  await prisma.listingImage
    .update({
      where: { id: imageId },
      data: { status: 'FAILED', failureReason: reason, processedAt: new Date() },
    })
    .catch(() => undefined);
}
