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

/**
 * The fuel queue, producer side only.
 *
 * The API enqueues a refresh when it finds no cached snapshot and then serves
 * the stale one immediately — see `getFuelSnapshot`. It never waits for this.
 */
const fuelQueue = new Queue<FuelRefreshJob>(QUEUE_NAMES.fuelPrices, {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
  },
});

export interface FuelRefreshJob {
  /** Which city prompted it. The job scrapes every city regardless. */
  citySlug: string;
}

/**
 * Asks for a fuel refresh, at most once per hour however many people ask.
 *
 * The `jobId` is the hour, not the city, and both halves of that matter. The
 * hour makes it idempotent: fifty viewers hitting a cold cache at 09:05 enqueue
 * one job, because BullMQ rejects a duplicate id — without it, a cache expiry on
 * a busy morning becomes fifty scrapes walking three sites each, which is a
 * self-inflicted burst on somebody else's server. Not the city, because the job
 * scrapes all of them anyway, so a per-city id would let three cities trigger
 * three identical full runs.
 */
export async function enqueueFuelRefresh(citySlug: string): Promise<void> {
  const hour = new Date().toISOString().slice(0, 13).replace(/[-T:]/g, '');

  await fuelQueue.add(
    'scrape-fuel-prices',
    { citySlug },
    // BullMQ rejects ":" in a custom id, hence the stripped timestamp.
    { jobId: `refresh-${hour}` },
  );

  logger.info({ citySlug, jobId: `refresh-${hour}` }, 'fuel refresh enqueued');
}

export async function closeQueues(): Promise<void> {
  await fuelQueue.close();
  await imagesQueue.close();
  if (connection.status !== 'end') {
    await connection.quit();
  }
}
