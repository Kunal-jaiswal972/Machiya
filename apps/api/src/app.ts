import { probeDatabase } from '@machiya/db';
import { toNodeHandler } from 'better-auth/node';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './env.js';
import { logger } from './logger.js';
import { probeRedis } from './lib/redis.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import type { SessionResolver } from './middleware/require-auth.js';
import { healthRouter, type HealthProbes } from './routes/health.js';
import { helloRouter } from './routes/hello.js';
import { listingsRouter } from './routes/listings.js';
import { meRouter } from './routes/me.js';
import { officesRouter } from './routes/offices.js';
import { placesRouter } from './routes/places.js';
import { searchRouter } from './routes/search.js';

export interface CreateAppOptions {
  /** Injectable so tests can exercise routes without live infrastructure. */
  probes?: HealthProbes;
  /** Injectable so guard tests need no cookies, database or auth provider. */
  sessionResolver?: SessionResolver;
  /**
   * Mounting Better Auth constructs the provider, which needs a real database
   * and Redis. Tests turn it off and inject a session resolver instead.
   */
  mountAuth?: boolean;
  corsOrigins?: string[];
  requestLogging?: boolean;
}

export async function createApp(options: CreateAppOptions = {}): Promise<Express> {
  const probes: HealthProbes = options.probes ?? {
    database: probeDatabase,
    redis: probeRedis,
  };
  const corsOrigins = options.corsOrigins ?? env.CORS_ORIGINS;
  const requestLogging = options.requestLogging ?? env.NODE_ENV !== 'test';
  const mountAuth = options.mountAuth ?? true;

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

  let sessionResolver = options.sessionResolver;

  if (mountAuth) {
    // Loaded lazily: importing the auth module constructs the Better Auth
    // instance, which opens a Prisma client and a Redis connection.
    const [{ auth }, { resolveSession }] = await Promise.all([
      import('./auth/index.js'),
      import('./auth/session.js'),
    ]);

    // MUST be above express.json(): the handler consumes the raw request
    // stream, and a parsed body leaves it empty. Express 5 needs the named
    // wildcard `*splat` — a bare `*` no longer matches.
    app.all('/api/auth/*splat', toNodeHandler(auth));

    sessionResolver ??= resolveSession;
  }

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Blunt per-IP ceiling for the application API. Credential endpoints are
  // limited an order of magnitude harder by Better Auth's own limiter, which
  // counts in Redis so the limits hold across replicas.
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: () => env.NODE_ENV === 'test',
    }),
  );

  app.use(healthRouter(probes));
  app.use('/api', helloRouter());
  // Public: picking an office is the product's first interaction and happens
  // before anyone signs in.
  app.use('/api', placesRouter());
  app.use('/api', searchRouter());

  if (sessionResolver) {
    app.use('/api', meRouter(sessionResolver));
    app.use('/api', listingsRouter(sessionResolver));
    app.use('/api', officesRouter(sessionResolver));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
