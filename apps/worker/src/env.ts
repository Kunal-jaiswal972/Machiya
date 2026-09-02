import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  REDIS_URL: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  /** Cron expression for the hourly fuel price scrape. */
  FUEL_SCRAPE_CRON: z.string().min(1).default('0 * * * *'),
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
