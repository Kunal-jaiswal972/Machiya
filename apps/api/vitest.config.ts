import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    restoreMocks: true,
    // The env module validates at import time; give it valid values that no test
    // actually dials out to.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      DATABASE_URL: 'postgresql://machiya:machiya@localhost:5432/machiya_test?schema=public',
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
