import { z } from 'zod';

/**
 * Browser-visible config. Anything here ships to the client, so nothing secret
 * belongs in it — that is enforced by convention plus the VITE_ prefix.
 */
const envSchema = z.object({
  VITE_API_BASE_URL: z.string().url().default('http://localhost:4000'),
  VITE_MAP_STYLE_URL: z.string().url().default('https://tiles.openfreemap.org/styles/liberty'),
  /**
   * Which sign-in methods to render. Must match the API's
   * AUTH_ENABLED_PROVIDERS: a button for a provider the server has not
   * configured fails at the OAuth redirect, which is a worse experience than
   * not offering it.
   */
  VITE_AUTH_PROVIDERS: z
    .string()
    .default('email')
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part.length > 0),
    ),
});

const parsed = envSchema.safeParse(import.meta.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid web environment:\n${details}`);
}

export const env = parsed.data;
