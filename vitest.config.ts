import { defineConfig } from 'vitest/config';

// The two pure modules — the vocabulary mapping and the serialization check —
// are the only ones that do not need a server, so they are held to a number in
// either mode. Everything else goes through BullMQ.
const pure = {
  'src/mapping.ts': { statements: 99, branches: 95, functions: 100, lines: 99 },
  'src/serialize.ts': { statements: 100, branches: 97, functions: 100, lines: 100 },
};

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // Gating the whole library on a figure a serverless run never verified
      // would be gating on nothing, so the overall bars apply only with Redis.
      // Note the globals cover only what `pure` does not: naming a file gives
      // it its own bar and takes it out of the overall figure.
      thresholds: process.env.ENQIU_TEST_REDIS_URL
        ? { statements: 97, branches: 87, functions: 95, lines: 97, ...pure }
        : pure,
    },
  },
});
