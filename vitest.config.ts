import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    globals: true,
    // Only the unit suite. e2e/ belongs to Playwright, and Vitest picking it up
    // fails with a confusing "did not expect test.describe() to be called here".
    include: ['test/**/*.test.ts', 'api/test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
