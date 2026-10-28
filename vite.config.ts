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

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    // CRASHYARD_STATE: where local D1 and R2 live (the end-to-end tests use a fresh one)
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      persistState: process.env.CRASHYARD_STATE ? { path: process.env.CRASHYARD_STATE } : true,
      // AUTH=crashyard SETUP_CODE=… pnpm dev: the dev server signs in with passkeys too, to work on sign-in
      // CONTAINERS=1 pnpm dev: the SymCache builder's container too, where wrangler.local.json has it (needs Docker)
      config: (config) => ({
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
          ...Object.fromEntries(['AUTH', 'SETUP_CODE'].flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : []))),
        },
      }),
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})
