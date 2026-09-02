import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * The API's producer-side view of the worker's queues. It enqueues and never
 * consumes: no image bytes, no sharp, no CPU spikes in the request path.
 *
 * BullMQ needs `maxRetriesPerRequest: null` on any connection it may block on.
 */
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

connection.on('error', (error: Error) => {
  logger.warn({ err: error, connection: 'queues' }, 'redis connection error');
});

export const QUEUE_NAMES = {
  images: 'images',
  fuelPrices: 'fuel-prices',
} as const;

export interface ProcessImageJob {
  listingId: string;
  imageId: string;
  objectKey: string;
}

const imagesQueue = new Queue<ProcessImageJob>(QUEUE_NAMES.images, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
});

/**
 * Enqueues derivation for one uploaded image.
 *
 * The job id IS the image id, so a duplicate "uploaded" call — a double-tap, a
 * retried request, a redelivery — collapses onto the same job instead of
 * resizing the same photo twice.
 */
export async function enqueueImageProcessing(job: ProcessImageJob): Promise<void> {
  // The job id IS the image id — a UUID. BullMQ rejects ":" in a custom id, so
  // it cannot be namespaced, and it does not need to be: the queue name already
  // scopes it.
  await imagesQueue.add('process-image', job, { jobId: job.imageId });
  logger.info({ listingId: job.listingId, imageId: job.imageId }, 'image processing enqueued');
}

export async function closeQueues(): Promise<void> {
  await imagesQueue.close();
  if (connection.status !== 'end') {
    await connection.quit();
  }
}
