import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    // One path through eight subsystems, including a real image derivation and
    // a real OSRM round trip. It is not a fast test and is not meant to be.
    testTimeout: 180_000,
    hookTimeout: 300_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      /**
       * A dedicated Redis database, flushed by global-setup.
       *
       * Better Auth's rate limiter counts sign-ups in Redis, and on database 0
       * that is the SAME counter the developer's own stack uses — so this suite
       * would burn their sign-in budget, and a second run inside five minutes
       * would fail with a 429 that has nothing to do with the path under test.
       * Isolating beats disabling: the limiter stays real.
       */
      REDIS_URL: 'redis://localhost:6379/3',
      CORS_ORIGINS: 'http://localhost:5173',
      WEB_APP_URL: 'http://localhost:5173',
      BETTER_AUTH_SECRET: 'e2e-only-secret-thirty-two-plus-characters',
      BETTER_AUTH_URL: 'http://localhost:4000',
      AUTH_TRUSTED_ORIGINS: 'http://localhost:5173',
      AUTH_ENABLED_PROVIDERS: 'email',
      // Real MinIO from compose. The presigned POST and the worker's read of
      // the uploaded object are both things a stub would prove nothing about.
      S3_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'machiya-listings',
      S3_ACCESS_KEY_ID: 'minioadmin',
      S3_SECRET_ACCESS_KEY: 'minioadmin',
      S3_FORCE_PATH_STYLE: 'true',
      S3_PUBLIC_BASE_URL: 'http://localhost:9000/machiya-listings',
      // Verification is off for the e2e account: the path under test is
      // sign-up to enquiry, not the mail round trip, which has its own cover.
      SMTP_HOST: 'localhost',
      SMTP_PORT: '1025',
    },
  },
});
