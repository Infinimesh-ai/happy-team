import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.spec.ts'],
    // pglite bootstrap and scrypt-heavy auth flows exceed the 5s/10s defaults
    // when spec files run concurrently on slower machines.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  plugins: [tsconfigPaths()]
}); 