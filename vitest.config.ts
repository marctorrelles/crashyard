import { defineConfig } from 'vitest/config'

// Unit tests are plain functions, run in Node in seconds; the Cloudflare plugin isn't loaded for them
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    hookTimeout: 60_000,
    // The end-to-end files each run a dev server with local D1: two at once trip over each other
    fileParallelism: false,
    testTimeout: 15_000,
  },
})
