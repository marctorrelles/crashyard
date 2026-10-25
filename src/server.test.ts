import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// Start's default server entry would skip the Access check in src/server.ts and leave the dashboard open
it('deploys src/server.ts as the worker’s entry', () => {
  expect(readFileSync('wrangler.jsonc', 'utf8')).toMatch(/"main":\s*"src\/server\.ts"/)
})
