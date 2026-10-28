// The build a release carries for installing it from the dashboard (src/update/install.ts): dist/ as `vite build`
// made it from wrangler.jsonc alone, and the migrations, as one gzipped JSON file. Run by the release workflow after
// `pnpm build`: node scripts/release-bundle.mjs <out file>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'

const out = process.argv[2] ?? 'crashyard.json.gz'
const files = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => relative(dir, join(f.parentPath, f.name)).split('\\').join('/'))
const base64 = (path) => readFileSync(path).toString('base64')

const config = JSON.parse(readFileSync('dist/server/wrangler.json', 'utf8'))
if (config.containers?.length || config.routes?.length)
  throw new Error('dist/ was built with a wrangler.local.json. Build the release without one.')

// The bindings it needs, by name: an update adding one is left to a deploy, which creates it
const named = (list, key = 'binding') => (list ?? []).map((b) => b[key])
const bindings = [
  ...named(config.d1_databases),
  ...named(config.r2_buckets),
  ...named(config.kv_namespaces),
  ...named(config.send_email, 'name'),
  ...named(config.durable_objects?.bindings, 'name'),
  ...named(config.services),
  ...named(config.queues?.producers),
  ...named(config.workflows),
  ...named(config.analytics_engine_datasets),
  ...named(config.hyperdrive),
  ...named(config.vectorize),
  ...[config.ai, config.browser, config.images, config.version_metadata].filter(Boolean).map((b) => b.binding),
]
const { directory: _, binding: __, ...assets } = config.assets ?? {}

const ignored = new Set(readFileSync('dist/client/.assetsignore', 'utf8').split('\n').filter(Boolean))
const bundle = {
  version: JSON.parse(readFileSync('package.json', 'utf8')).version,
  worker: {
    main: config.main,
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags ?? [],
    crons: config.triggers?.crons ?? [],
    assets,
    bindings,
  },
  server: Object.fromEntries(
    files('dist/server')
      .filter((f) => /\.(m?js|wasm)$/.test(f))
      .map((f) => [f, base64(join('dist/server', f))]),
  ),
  client: Object.fromEntries(
    files('dist/client')
      .filter((f) => f !== '.assetsignore' && !ignored.has(f))
      .map((f) => [f, base64(join('dist/client', f))]),
  ),
  migrations: Object.fromEntries(
    readdirSync('migrations')
      .filter((f) => f.endsWith('.sql'))
      .map((f) => [f, readFileSync(join('migrations', f), 'utf8')]),
  ),
}
writeFileSync(out, gzipSync(JSON.stringify(bundle)))
console.log(
  `${out}: crashyard ${bundle.version}, ${Object.keys(bundle.server).length} modules, ${Object.keys(bundle.client).length} assets`,
)
