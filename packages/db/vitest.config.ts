import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // One PostGIS container for the whole suite; see test/global-setup.ts.
    globalSetup: ['./test/global-setup.ts'],
    // The geo queries share one database, so parallel files would race on the
    // fixture set. The suite is small enough that serial costs nothing.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
    restoreMocks: true,
  },
});
