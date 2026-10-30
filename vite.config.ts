import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Your deployment's own values (domain, PUBLIC_URL), git-ignored, over wrangler.jsonc's: `vars` merged, the rest
// replaced
const local = existsSync('wrangler.local.json') ? JSON.parse(readFileSync('wrangler.local.json', 'utf8')) : null

// A new id each build: the page keeps its own, `__BUILD__`, and asks `/version.json` for the deployed one
// (src/components/new-version.tsx). Kept in the environment, as the build reads this file more than once
const BUILD = (process.env.CRASHYARD_BUILD ??= Date.now().toString(36))

export default defineConfig({
  resolve: { tsconfigPaths: true },
  define: { __BUILD__: JSON.stringify(BUILD) },
  plugins: [
    {
      name: 'crashyard:version',
      apply: 'build',
      generateBundle() {
        if (this.environment.name === 'client')
          this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD }) })
      },
    },
    // CRASHYARD_STATE: where local D1 and R2 live (the end-to-end tests use a fresh one)
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      persistState: process.env.CRASHYARD_STATE ? { path: process.env.CRASHYARD_STATE } : true,
      // AUTH=crashyard SETUP_CODE=… pnpm dev: the dev server signs in with passkeys too, to work on sign-in
      // CONTAINERS=1 pnpm dev: the SymCache builder's container too, where wrangler.local.json has it (needs Docker)
      // DEMO=1 pnpm dev: the public demo's read-only mode (src/demo.ts)
      config: (config) => {
        // The plugin merges what this returns with defu, which adds lists together: a list the overlay sets (its D1
        // database, its R2 bucket) would come after wrangler.jsonc's, two bindings of one name. Out of the config it
        // passes, so the overlay's replaces it
        for (const [key, value] of Object.entries(local ?? {}))
          if (Array.isArray(value)) delete (config as Record<string, unknown>)[key]
        return {
          ...local,
          // A container's Dockerfile from the root, as the build's own wrangler.json (dist/server) reads it from there too
          ...(local?.containers && {
            containers: local.containers.map((c: { image: string }) => ({
              ...c,
              image: c.image.startsWith('.') ? resolve(c.image) : c.image,
            })),
          }),
          dev: { ...config.dev, enable_containers: process.env.CONTAINERS === '1' },
          vars: {
            ...config.vars,
            ...local?.vars,
            ...Object.fromEntries(
              ['AUTH', 'SETUP_CODE', 'DEMO'].flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])),
            ),
          },
        }
      },
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})
