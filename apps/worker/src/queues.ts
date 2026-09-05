import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from './env.js';

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it blocks on,
 * otherwise long-lived workers get killed by ioredis retry limits.
 */
export function createConnection(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

export const QUEUE_NAMES = {
  images: 'images',
  fuelPrices: 'fuel-prices',
  maintenance: 'maintenance',
  notifications: 'notifications',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export function createQueue(name: QueueName, connection: ConnectionOptions): Queue {
  return new Queue(name, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });
}

export function createWorker(
  name: QueueName,
  processor: (job: Job) => Promise<unknown>,
  connection: ConnectionOptions,
  options: { concurrency?: number } = {},
): Worker {
  return new Worker(name, processor, { connection, concurrency: options.concurrency ?? 2 });
}
