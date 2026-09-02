import { disconnectPrisma } from '@machiya/db';
import { createApp } from './app.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { closeRedis } from './lib/redis.js';

const app = await createApp();

const server = app.listen(env.API_PORT, env.API_HOST, () => {
  logger.info({ port: env.API_PORT, host: env.API_HOST, env: env.NODE_ENV }, 'api listening');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');

  server.close((closeError) => {
    void (async () => {
      if (closeError) {
        logger.error({ err: closeError }, 'error closing http server');
      }
      await Promise.allSettled([disconnectPrisma(), closeRedis()]);
      process.exit(closeError ? 1 : 0);
    })();
  });

  // Never hang forever on a stuck connection.
  setTimeout(() => {
    logger.error('forced exit after shutdown timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
