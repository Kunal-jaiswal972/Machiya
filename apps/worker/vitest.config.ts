import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
    // The reconciler is tested against real Postgres and real Redis; see
    // test/global-setup.ts for why a mock would prove nothing.
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      REDIS_URL: 'redis://localhost:6379',
    },
  },
});
