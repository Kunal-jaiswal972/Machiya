import { enabledProvidersSchema } from '@machiya/shared';
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

  /** Where the browser app lives. Verification and reset links point back here. */
  WEB_APP_URL: z.string().url().default('http://localhost:5173'),

  // --- Better Auth ---
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:4000'),
  AUTH_TRUSTED_ORIGINS: z.string().default('http://localhost:5173').transform(csv),
  /** Comma-separated subset of email,google,github. */
  AUTH_ENABLED_PROVIDERS: enabledProvidersSchema,

  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GITHUB_CLIENT_ID: z.string().default(''),
  GITHUB_CLIENT_SECRET: z.string().default(''),

  // --- Outbound mail (MailHog in dev) ---
  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_SECURE: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  MAIL_FROM: z.string().min(1).default('Machiya <no-reply@machiya.local>'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parsed once at boot. A missing or malformed variable is a startup failure, not
 * a runtime surprise — the process refuses to serve rather than half-working.
 *
 * That matters most for BETTER_AUTH_SECRET: a short or absent secret would
 * otherwise surface as silently forgeable session cookies.
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
