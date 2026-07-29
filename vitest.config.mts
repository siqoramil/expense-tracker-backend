import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the `@/*` paths from tsconfig.json. Native since Vite 7 — this
  // replaces the vite-tsconfig-paths plugin.
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
