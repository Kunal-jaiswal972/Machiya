import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    restoreMocks: true,
    // The listing service tests need real PostGIS; see test/global-setup.ts.
    globalSetup: ['./test/global-setup.ts'],
    // They share one database, so parallel files would race on fixtures.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
    // The env module validates at import time; give it valid values that no test
    // actually dials out to.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      REDIS_URL: 'redis://localhost:6379',
      CORS_ORIGINS: 'http://localhost:5173',
      WEB_APP_URL: 'http://localhost:5173',
      // 32+ chars, never used to sign anything real: these tests never
      // construct the auth provider.
      BETTER_AUTH_SECRET: 'test-only-secret-thirty-two-plus-chars',
      BETTER_AUTH_URL: 'http://localhost:4000',
      AUTH_TRUSTED_ORIGINS: 'http://localhost:5173',
      AUTH_ENABLED_PROVIDERS: 'email',
    },
  },
});
