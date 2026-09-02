import { createServer } from 'node:http';
import { disconnectPrisma } from '@machiya/db';
import { env } from './env.js';
import { logger } from './logger.js';
import { QUEUE_NAMES, createConnection, createQueue, createWorker } from './queues.js';

const connection = createConnection();
const fuelQueue = createQueue(QUEUE_NAMES.fuelPrices, connection);

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

fuelWorker.on('failed', (job, error) => {
  logger.error({ jobId: job?.id, err: error }, 'job failed');
});

async function registerSchedules(): Promise<void> {
  await fuelQueue.upsertJobScheduler(
    'fuel-prices-hourly',
    { pattern: env.FUEL_SCRAPE_CRON },
    { name: 'scrape-fuel-prices' },
  );
  logger.info({ cron: env.FUEL_SCRAPE_CRON }, 'fuel price schedule registered');
}

// Plain HTTP health endpoint so Docker can tell a live worker from a wedged one.
const health = createServer((req, res) => {
  if (req.url === '/health' || req.url === '/health/live') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        status: fuelWorker.isRunning() ? 'ok' : 'degraded',
        service: 'worker',
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
    logger.info({ port: env.WORKER_PORT }, 'worker health server listening');
  });
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down worker');
  health.close();
  await Promise.allSettled([fuelWorker.close(), fuelQueue.close(), disconnectPrisma()]);
  await connection.quit();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'worker failed to start');
  process.exit(1);
});
