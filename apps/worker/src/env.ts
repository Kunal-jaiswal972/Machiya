import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  REDIS_URL: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  /** Cron expression for the hourly fuel price scrape. */
  FUEL_SCRAPE_CRON: z.string().min(1).default('0 * * * *'),

  // --- Outbound mail -------------------------------------------------------
  // The worker sends the enquiry notification, so it needs its own transport
  // rather than reaching through the API for one.
  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_SECURE: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  MAIL_FROM: z.string().min(1).default('Machiya <no-reply@machiya.local>'),
  /** Where notification links point. */
  WEB_APP_URL: z.string().url().default('http://localhost:5173'),

  // --- Object storage ------------------------------------------------------
  S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1).default('machiya-listings'),
  S3_ACCESS_KEY_ID: z.string().min(1).default('minioadmin'),
  S3_SECRET_ACCESS_KEY: z.string().min(1).default('minioadmin'),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((value) => value === 'true'),

  // --- Image pipeline ------------------------------------------------------
  /** Parallel image jobs. libvips is threaded, so this is not the whole story. */
  IMAGE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(3),
  /**
   * Keep the uploaded original after derivatives are written. Off by default:
   * the originals prefix is private and nothing serves from it, so retaining
   * them only grows the bucket.
   */
  KEEP_ORIGINALS: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  /** Sweep PENDING rows and orphaned originals older than this. */
  IMAGE_CLEANUP_AFTER_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  IMAGE_CLEANUP_CRON: z.string().min(1).default('17 * * * *'),
  /**
   * How often the reconciler looks for PENDING rows nothing is processing.
   * Sixty seconds: the window in which a dropped enqueue is invisible to the
   * user should be shorter than their patience with a spinner. See D40.
   */
  IMAGE_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(5_000).max(600_000).default(60_000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid worker environment:\n${details}`);
  }

  return parsed.data;
}

export const env: Env = loadEnv();
