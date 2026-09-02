import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { probeDatabase } from '@machiya/db';
import { env } from './env.js';
import { logger } from './logger.js';
import { probeRedis } from './lib/redis.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { healthRouter, type HealthProbes } from './routes/health.js';
import { helloRouter } from './routes/hello.js';

export interface CreateAppOptions {
  /** Injectable so tests can exercise routes without live infrastructure. */
  probes?: HealthProbes;
  corsOrigins?: string[];
  requestLogging?: boolean;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const probes: HealthProbes = options.probes ?? {
    database: probeDatabase,
    redis: probeRedis,
  };
  const corsOrigins = options.corsOrigins ?? env.CORS_ORIGINS;
  const requestLogging = options.requestLogging ?? env.NODE_ENV !== 'test';

  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  if (requestLogging) {
    app.use(pinoHttp({ logger }));
  }

  app.use(
    helmet({
      // The API serves JSON only. Map and tile CSP is the web app concern.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    }),
  );

  app.use(cookieParser());

  // Better Auth mounts at /api/auth/* in step 3 and must sit ABOVE the JSON body
  // parser, because its handler needs to consume the raw request stream.

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.use(healthRouter(probes));
  app.use('/api', helloRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
