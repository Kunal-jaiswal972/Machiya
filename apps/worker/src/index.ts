import { createServer } from 'node:http';
import { disconnectPrisma } from '@machiya/db';
import type { Job, Queue } from 'bullmq';
import sharp from 'sharp';
import { env } from './env.js';
import { cleanupImages } from './jobs/cleanup-images.js';
import { markImageFailed, processImageJob, type ProcessImageJob } from './jobs/process-image.js';
import {
  markNotificationFailed,
  notifyEnquiry,
  type EnquiryNotificationJob,
} from './jobs/notify-enquiry.js';
import { reconcileImages } from './jobs/reconcile-images.js';
import { reconcileNotifications } from './jobs/reconcile-notifications.js';
import { scrapeFuelPrices } from './jobs/scrape-fuel-prices.js';
import { warmPois } from './jobs/warm-pois.js';
import { logger } from './logger.js';
import { closeMailer } from './lib/mailer.js';
import { closeWorkerRedis } from './lib/redis.js';
import { QUEUE_NAMES, createConnection, createQueue, createWorker } from './queues.js';

/**
 * libvips is itself threaded. Left alone it spawns a thread pool per operation,
 * so N concurrent jobs become N x cores threads and the container thrashes.
 * One libvips thread per job, with BullMQ controlling how many jobs run, keeps
 * memory and CPU predictable — which is the entire reason this work is here and
 * not in the API.
 */
sharp.concurrency(1);
sharp.cache({ memory: 64, files: 0, items: 64 });

const connection = createConnection();

const imagesQueue = createQueue(QUEUE_NAMES.images, connection) as Queue<ProcessImageJob>;
const fuelQueue = createQueue(QUEUE_NAMES.fuelPrices, connection);
const maintenanceQueue = createQueue(QUEUE_NAMES.maintenance, connection);
const notificationsQueue = createQueue(
  QUEUE_NAMES.notifications,
  connection,
) as Queue<EnquiryNotificationJob>;

const imageWorker = createWorker(
  QUEUE_NAMES.images,
  (job) => processImageJob(job as Job<ProcessImageJob>),
  connection,
  { concurrency: env.IMAGE_CONCURRENCY },
);

imageWorker.on('failed', (job, error) => {
  const data = job?.data as ProcessImageJob | undefined;
  const attemptsLeft = (job?.opts.attempts ?? 1) - (job?.attemptsMade ?? 0);

  logger.error({ jobId: job?.id, err: error, attemptsLeft }, 'image job failed');

  // Only once BullMQ has given up: before that a retry may still succeed, and
  // flipping the row to FAILED early would show the user a dead end.
  if (data?.imageId && attemptsLeft <= 0) {
    void markImageFailed(data.imageId, 'Processing failed after several attempts');
  }
});

/**
 * The hourly fuel scrape, plus the on-demand refresh the API enqueues on a
 * cache miss.
 *
 * Concurrency stays at the default rather than being raised: the job walks
 * three cities x three sources in series on purpose, because 27 requests fired
 * at once is a burst against somebody else's server for no gain when the job
 * has a whole hour. Two of these running at once would defeat that.
 *
 * `jobId` on the enqueue side is what stops a stampede of refreshes; see
 * `enqueueFuelRefresh` in the API.
 */
const fuelWorker = createWorker(
  QUEUE_NAMES.fuelPrices,
  async (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'fuel price job picked up');
    return await scrapeFuelPrices();
  },
  connection,
  { concurrency: 1 },
);

/**
 * Outbound enquiry mail.
 *
 * Concurrency 2 rather than the default: SMTP servers rate-limit, and a burst
 * of parallel sends is the fastest way to be told so. There is no hurry — the
 * job exists precisely so nobody is waiting on it.
 */
const notificationWorker = createWorker(
  QUEUE_NAMES.notifications,
  (job) => notifyEnquiry(job as Job<EnquiryNotificationJob>),
  connection,
  { concurrency: 2 },
);

notificationWorker.on('failed', (job, error) => {
  const attemptsLeft = (job?.opts.attempts ?? 1) - (job?.attemptsMade ?? 0);
  logger.error({ jobId: job?.id, err: error, attemptsLeft }, 'enquiry notification failed');

  // Only once BullMQ has given up. Before that a retry may still deliver, and
  // marking it failed early would stop the reconciler from ever trying again.
  if (job?.id && attemptsLeft <= 0) {
    void markNotificationFailed(job.id);
  }
});

const maintenanceWorker = createWorker(
  QUEUE_NAMES.maintenance,
  async (job) => {
    if (job.name === 'cleanup-images') {
      const result = await cleanupImages();
      logger.info(result, 'image cleanup finished');
      return result;
    }

    if (job.name === 'reconcile-images') {
      // Runs every minute and is silent when there is nothing to do, which is
      // almost always. See DECISIONS.md D40.
      return await reconcileImages(imagesQueue);
    }

    if (job.name === 'reconcile-notifications') {
      // Same shape, same silence, same reason. See DECISIONS.md D68.
      return await reconcileNotifications(notificationsQueue);
    }

    if (job.name === 'warm-pois') {
      // Gated on the geo epoch, so this is a no-op reading one Redis key on
      // almost every tick. See DECISIONS.md D86.
      const result = await warmPois();
      if (result.requested > 0) logger.info(result, 'POI warm ran');
      return result;
    }

    return undefined;
  },
  connection,
  { concurrency: 1 },
);

for (const worker of [fuelWorker, maintenanceWorker]) {
  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, err: error }, 'job failed');
  });
}

async function registerSchedules(): Promise<void> {
  await fuelQueue.upsertJobScheduler(
    'fuel-prices-hourly',
    { pattern: env.FUEL_SCRAPE_CRON },
    { name: 'scrape-fuel-prices' },
  );

  await maintenanceQueue.upsertJobScheduler(
    'image-cleanup',
    { pattern: env.IMAGE_CLEANUP_CRON },
    { name: 'cleanup-images' },
  );

  // Every 60 seconds, not on a cron pattern: cron's finest granularity is a
  // minute anyway, and `every` keeps the interval honest across restarts.
  await maintenanceQueue.upsertJobScheduler(
    'image-reconcile',
    { every: env.IMAGE_RECONCILE_INTERVAL_MS },
    { name: 'reconcile-images' },
  );

  await maintenanceQueue.upsertJobScheduler(
    'notification-reconcile',
    { every: env.NOTIFY_RECONCILE_INTERVAL_MS },
    { name: 'reconcile-notifications' },
  );

  await maintenanceQueue.upsertJobScheduler(
    'poi-warm',
    { every: env.POI_WARM_INTERVAL_MS },
    { name: 'warm-pois' },
  );

  logger.info(
    {
      fuel: env.FUEL_SCRAPE_CRON,
      imageCleanup: env.IMAGE_CLEANUP_CRON,
      imageReconcileMs: env.IMAGE_RECONCILE_INTERVAL_MS,
      notifyReconcileMs: env.NOTIFY_RECONCILE_INTERVAL_MS,
      poiWarmMs: env.POI_WARM_INTERVAL_MS,
    },
    'schedules registered',
  );
}

// Plain HTTP health endpoint so Docker can tell a live worker from a wedged one.
const health = createServer((req, res) => {
  if (req.url === '/health' || req.url === '/health/live') {
    const running = imageWorker.isRunning() && fuelWorker.isRunning();
    res.writeHead(running ? 200 : 503, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        status: running ? 'ok' : 'degraded',
        service: 'worker',
        queues: {
          images: imageWorker.isRunning(),
          fuelPrices: fuelWorker.isRunning(),
          maintenance: maintenanceWorker.isRunning(),
          notifications: notificationWorker.isRunning(),
        },
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      }),
    );
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'not_found', message: 'No route' } }));
});

async function main(): Promise<void> {
  await registerSchedules();
  health.listen(env.WORKER_PORT, () => {
    logger.info(
      { port: env.WORKER_PORT, imageConcurrency: env.IMAGE_CONCURRENCY },
      'worker listening',
    );
  });
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down worker');
  health.close();

  // Close workers before queues so an in-flight image finishes writing.
  await Promise.allSettled([
    imageWorker.close(),
    fuelWorker.close(),
    maintenanceWorker.close(),
    notificationWorker.close(),
  ]);
  await Promise.allSettled([
    imagesQueue.close(),
    fuelQueue.close(),
    maintenanceQueue.close(),
    notificationsQueue.close(),
    disconnectPrisma(),
    closeWorkerRedis(),
    closeMailer(),
  ]);
  await connection.quit();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'worker failed to start');
  process.exit(1);
});
