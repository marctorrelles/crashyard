import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    // CRASHYARD_STATE: where local D1 and R2 live (the end-to-end tests use a fresh one)
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      persistState: process.env.CRASHYARD_STATE ? { path: process.env.CRASHYARD_STATE } : true,
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})
