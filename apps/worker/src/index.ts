import { createServer } from 'node:http';
import { disconnectPrisma } from '@machiya/db';
import type { Job } from 'bullmq';
import sharp from 'sharp';
import { env } from './env.js';
import { cleanupImages } from './jobs/cleanup-images.js';
import { markImageFailed, processImageJob, type ProcessImageJob } from './jobs/process-image.js';
import { logger } from './logger.js';
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

const imagesQueue = createQueue(QUEUE_NAMES.images, connection);
const fuelQueue = createQueue(QUEUE_NAMES.fuelPrices, connection);
const maintenanceQueue = createQueue(QUEUE_NAMES.maintenance, connection);

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
 * Placeholder processor. The real fuel price adapters land in step 8; until then
 * this proves the queue, the scheduler and the Redis wiring actually work.
 */
const fuelWorker = createWorker(
  QUEUE_NAMES.fuelPrices,
  async (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'fuel price job picked up');
    return { scrapedAt: new Date().toISOString(), adapters: 0 };
  },
  connection,
);

const maintenanceWorker = createWorker(
  QUEUE_NAMES.maintenance,
  async (job) => {
    if (job.name === 'cleanup-images') {
      const result = await cleanupImages();
      logger.info(result, 'image cleanup finished');
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

  logger.info(
    { fuel: env.FUEL_SCRAPE_CRON, imageCleanup: env.IMAGE_CLEANUP_CRON },
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
  await Promise.allSettled([imageWorker.close(), fuelWorker.close(), maintenanceWorker.close()]);
  await Promise.allSettled([
    imagesQueue.close(),
    fuelQueue.close(),
    maintenanceQueue.close(),
    disconnectPrisma(),
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
