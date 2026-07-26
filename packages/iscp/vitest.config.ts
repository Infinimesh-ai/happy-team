import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: process.env.ISCP_HARNESS
      ? []
      : ['src/integration/**', 'node_modules/**'],
    benchmark: {
      include: ['src/**/*.bench.ts'],
    },
    testTimeout: 30000,
  },
});
