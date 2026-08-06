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
      // skipped would report a figure the default suite never verifies, so it
      // joins the report exactly when its tests actually run.
      exclude: process.env.ENQIU_TEST_REDIS_URL ? [] : ['src/redis.ts'],
      // Set just under the current numbers so a regression fails the build
      // without the suite going red on ordinary rounding. The Redis run covers
      // strictly more code, including a driver whose Lua-adjacent guards are
      // hard to drive from the outside, so its branch bar is lower.
      thresholds: process.env.ENQIU_TEST_REDIS_URL
        ? { statements: 94, branches: 85, functions: 92, lines: 94 }
        : { statements: 95, branches: 90, functions: 93, lines: 95 },
    },
  },
});
