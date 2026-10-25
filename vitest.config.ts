import { defineConfig } from 'vitest/config'

// Unit tests are plain functions, run in Node in seconds; the Cloudflare plugin isn't loaded for them
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: { include: ['src/**/*.test.ts', 'test/**/*.test.ts'] },
})
