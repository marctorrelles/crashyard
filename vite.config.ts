import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

// Your deployment's own values (domain, Access, PUBLIC_URL), git-ignored, over wrangler.jsonc's: `vars` merged, the rest
// replaced
const local = existsSync('wrangler.local.json') ? JSON.parse(readFileSync('wrangler.local.json', 'utf8')) : null

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    // CRASHYARD_STATE: where local D1 and R2 live (the end-to-end tests use a fresh one)
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      persistState: process.env.CRASHYARD_STATE ? { path: process.env.CRASHYARD_STATE } : true,
      config: local ? (config) => ({ ...local, vars: { ...config.vars, ...local.vars } }) : undefined,
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})
