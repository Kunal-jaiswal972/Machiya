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

  // --- Object storage (MinIO in dev, Cloudflare R2 in prod) ---------------
  S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1).default('machiya-listings'),
  S3_ACCESS_KEY_ID: z.string().min(1).default('minioadmin'),
  S3_SECRET_ACCESS_KEY: z.string().min(1).default('minioadmin'),
  /** MinIO needs path-style addressing; R2 and S3 do not. */
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((value) => value === 'true'),
  /** Public base URL objects are served from, for building image URLs. */
  S3_PUBLIC_BASE_URL: z.string().url().default('http://localhost:9000/machiya-listings'),

  // --- OSM artifacts -------------------------------------------------------
  /**
   * Where `scripts/bootstrap.sh` left the artifact manifest. Its `epoch` field
   * prefixes every derived cache key, so a rebuild strands the old entries
   * instead of serving them. Relative paths resolve against the process's cwd,
   * which is the repo root in dev and `/app` in the container — hence the
   * absolute default in compose, where `./osm-data` is mounted at `/osm`.
   */
  GEO_MANIFEST_PATH: z.string().min(1).default('osm-data/manifest.json'),

  // --- Geocoding -----------------------------------------------------------
  /**
   * Which geocoder the adapter selects. `nominatim` is the only value today —
   * the variable exists so the choice is explicit and swappable rather than
   * hardcoded in the adapter. Photon was evaluated and removed; see D26.
   */
  GEOCODE_PROVIDER: z.enum(['nominatim']).default('nominatim'),
  NOMINATIM_URL: z.string().url().default('http://localhost:7070'),
  /** Sent to the public instance, which rejects requests without a real one. */
  NOMINATIM_USER_AGENT: z.string().min(1).default('Machiya/0.1 (contact@example.com)'),

  // --- Routing (OSRM) ------------------------------------------------------
  OSRM_CAR_URL: z.string().url().default('http://localhost:5100'),
  OSRM_BIKE_URL: z.string().url().default('http://localhost:5001'),
  /** Local escape hatch when the self-hosted graphs are not built yet. */
  ALLOW_PUBLIC_OSRM: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  PUBLIC_OSRM_URL: z.string().url().default('https://router.project-osrm.org'),

  // --- POIs (Overpass) -----------------------------------------------------
  /**
   * Defaults to the Kumi Systems mirror, NOT overpass-api.de. The main instance
   * answers 406 Not Acceptable to every User-Agent tried except curl's own —
   * verified against four candidate UAs — and spoofing curl to get past a
   * mirror's own policy is not a fix. Kumi accepts the descriptive UA this app
   * sends. See docs/geo.md for the other mirrors and the self-host path.
   */
  OVERPASS_URL: z.string().url().default('https://overpass.kumi.systems/api/interpreter'),
  /**
   * Deliberately long, because this is the ceiling on a BACKGROUND warm and on
   * the `[timeout:]` inside the Overpass query itself — never on anything a
   * user waits for. Measured against a healthy public mirror, the batched
   * seven-category query takes 38 seconds on a good run and exceeds 50 on a
   * throttled one. See apps/api/src/geo/overpass.ts.
   */
  OVERPASS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(180_000).default(90_000),
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
