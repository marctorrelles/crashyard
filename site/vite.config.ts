// crashyard.dev: index.html and styles.css (Tailwind) built to dist/, with public/ (images, fonts) copied as they are
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  root: import.meta.dirname,
  plugins: [tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
})
