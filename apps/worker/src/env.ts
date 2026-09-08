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

  // --- POI cache warm ------------------------------------------------------
  /**
   * The API, from inside the compose network. The POI warm goes through the
   * API's own endpoint so the cache keys it fills are the ones the request path
   * reads (D86); this is where it finds it.
   */
  API_INTERNAL_URL: z.string().url().default('http://localhost:4000'),
  /**
   * How often to check whether the geo epoch has moved. Almost every tick is a
   * no-op that reads one Redis key, so this is cheap; it only has to be sooner
   * than a human noticing a rebuild.
   */
  POI_WARM_INTERVAL_MS: z.coerce.number().int().min(10_000).default(300_000),
  /**
   * Pause between warm requests. Two constraints, and the tighter one is the
   * API's own per-IP limiter at 300/minute: 250ms is 240/minute, which spends
   * 80% of the budget on a job nobody is waiting for. 500ms halves that. The
   * other is Overpass, which answers one query at a time behind fcgiwrap — at
   * zero the warm competes with real page loads for the only interpreter.
   */
  POI_WARM_DELAY_MS: z.coerce.number().int().min(0).default(500),
  /**
   * Ceiling on one warm request. Generous because a cold Overpass read is the
   * slow case this exists to remove, and a timeout here just means the listing
   * is retried on the next tick.
   */
  POI_WARM_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
  /**
   * How the warm names itself to the API. These requests land in the access log
   * next to real page loads, so anything reading that log needs to be able to
   * tell machine traffic from a person. `MachiyaBot` is the fuel scraper's
   * convention (`FUEL_USER_AGENT`) pointed inward.
   */
  POI_WARM_USER_AGENT: z
    .string()
    .min(1)
    .default(
      'MachiyaBot/0.1 (+https://github.com/Kunal-jaiswal972/Machiya; internal POI cache warm)',
    ),
  /**
   * Shared secret that exempts internal traffic from the API's per-IP rate
   * limit. Empty by default, and an empty value exempts nothing — the warm then
   * lives inside the same 300/minute budget as anybody else, which is the safe
   * failure. NOT a credential: it buys a limiter bypass and no authorization.
   */
  INTERNAL_REQUEST_TOKEN: z.string().default(''),

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

  /**
   * How often the notification reconciler looks for enquiry messages owed a
   * mail that nothing is sending.
   *
   * Two minutes rather than the image reconciler's one: a dropped notification
   * is invisible to everybody, so nobody is watching a spinner, and the scan
   * costs a query per interval. See D68.
   */
  NOTIFY_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(10_000).max(900_000).default(120_000),
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
