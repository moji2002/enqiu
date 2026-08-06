import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // Enqiu is a layer over BullMQ, so almost everything needs a real Redis.
      // Without ENQIU_TEST_REDIS_URL only the codec runs, and gating on that
      // figure would be gating on a number the run never verified.
      thresholds: process.env.ENQIU_TEST_REDIS_URL
        ? { statements: 90, branches: 75, functions: 80, lines: 90 }
        : { statements: 0, branches: 0, functions: 0, lines: 0 },
    },
  },
});
