import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts', 'examples/testing/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // src/redis.ts is exercised only by test/redis.test.ts, which is skipped
      // unless ENQIU_TEST_REDIS_URL points at a server. Counting it while it is
      // skipped would report a figure the default suite never verifies.
      exclude: ['src/redis.ts'],
      // Set just under the current numbers so a regression fails the build
      // without the suite going red on ordinary rounding.
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 93,
        lines: 95,
      },
    },
  },
});
