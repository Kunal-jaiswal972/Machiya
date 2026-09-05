import { redisStorage } from '@better-auth/redis-storage';
import { prisma } from '@machiya/db';
import { AUTH_BASE_PATH, DEFAULT_ROLE } from '@machiya/shared';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { admin as adminPlugin, openAPI } from 'better-auth/plugins';
import { env } from '../env.js';
import { ac, roles } from '@machiya/shared/auth-access';
import { authRedis } from '../lib/redis.js';
import { sendPasswordResetEmail, sendVerificationEmail } from './emails.js';

const providers = env.AUTH_ENABLED_PROVIDERS;
const isProduction = env.NODE_ENV === 'production';

/**
 * A provider is only wired up when it is BOTH listed in AUTH_ENABLED_PROVIDERS
 * and actually configured. Half-configured OAuth is worse than absent: the
 * button renders and then fails at the redirect.
 */
function socialProviders() {
  const configured: Record<string, { clientId: string; clientSecret: string }> = {};

  if (providers.includes('google') && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    configured.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    };
  }

  if (providers.includes('github') && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    configured.github = {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    };
  }

  return configured;
}

export const auth = betterAuth({
  appName: 'Machiya',
  baseURL: env.BETTER_AUTH_URL,
  basePath: AUTH_BASE_PATH,
  secret: env.BETTER_AUTH_SECRET,

  database: prismaAdapter(prisma, { provider: 'postgresql' }),

  // Sessions live in Postgres; Redis fronts them for read speed and backs the
  // rate limiter's counters. This uses the auth-specific connection, not the
  // fail-fast cache one — see the comment in lib/redis.ts.
  secondaryStorage: redisStorage({ client: authRedis, keyPrefix: 'better-auth:' }),

  trustedOrigins: env.AUTH_TRUSTED_ORIGINS,

  user: {
    // The app calls it avatarUrl; Better Auth calls it image.
    fields: { image: 'avatarUrl' },
    additionalFields: {
      phone: { type: 'string', required: false, input: false },
      isPhoneVerified: { type: 'boolean', required: false, input: false },
    },
  },

  emailAndPassword: {
    enabled: providers.includes('email'),
    requireEmailVerification: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 60 * 60,
    sendResetPassword: async ({ user, token }) => {
      const url = `${env.WEB_APP_URL}/auth/reset-password?token=${encodeURIComponent(token)}`;
      await sendPasswordResetEmail({ to: user.email, name: user.name, url });
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60,
    sendVerificationEmail: async ({ user, token, url }) => {
      // The handler must stay on the API — it is what consumes the token — but
      // its callbackURL defaults to the API's own baseURL, which would drop the
      // user on a bare JSON host after verifying. Rebuild it so they land back
      // in the app. `url` is kept as the fallback if the shape ever changes.
      const verifyUrl = token
        ? `${env.BETTER_AUTH_URL}${AUTH_BASE_PATH}/verify-email?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent(`${env.WEB_APP_URL}/`)}`
        : url;

      await sendVerificationEmail({ to: user.email, name: user.name, url: verifyUrl });
    },
  },

  socialProviders: socialProviders(),

  session: {
    expiresIn: 60 * 60 * 24 * 30,
    // Rolling expiry: an active session is extended at most once a day.
    updateAge: 60 * 60 * 24,
    // Reads come from Redis, but the row lives in Postgres. Without this,
    // providing secondaryStorage moves sessions into Redis ONLY, which would
    // mean a Redis restart signs everybody out and no session is auditable.
    storeSessionInDatabase: true,
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },

  advanced: {
    cookiePrefix: 'machiya',
    useSecureCookies: isProduction,
    defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
  },

  rateLimit: {
    enabled: true,
    // Counters in Redis, so limits hold across API replicas.
    storage: 'secondary-storage',
    window: 60,
    max: 100,
    // Credential endpoints are limited far harder than the rest of the API.
    customRules: {
      '/sign-in/email': { window: 60, max: 5 },
      '/sign-up/email': { window: 300, max: 3 },
      // 1.7 renamed this from /forget-password; the old key silently matched
      // nothing. Verify route names against `pnpm auth:routes` after upgrades.
      '/request-password-reset': { window: 300, max: 3 },
      '/reset-password': { window: 300, max: 5 },
      '/send-verification-email': { window: 300, max: 3 },
    },
  },

  plugins: [
    // `ac` and `roles` are not optional here. Without them every endpoint on
    // this plugin answers 403, because the permission check resolves our role
    // names against the plugin's built-in admin/user map and misses. See
    // apps/api/src/auth/access.ts and DECISIONS.md D70.
    adminPlugin({ defaultRole: DEFAULT_ROLE, adminRoles: ['ADMIN'], ac, roles }),
    // Route explorer at /api/auth/reference. Never in production.
    ...(isProduction ? [] : [openAPI()]),
  ],
});

export type Auth = typeof auth;
