import { z } from 'zod';

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().min(1).default('0.0.0.0'),

  /** Browser origins allowed to send credentialed requests. */
  CORS_ORIGINS: z.string().default('http://localhost:5173').transform(csv),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parsed once at boot. A missing or malformed variable is a startup failure, not
 * a runtime surprise — the process refuses to serve rather than half-working.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid API environment:\n${details}`);
  }

  return parsed.data;
}

export const env: Env = loadEnv();
