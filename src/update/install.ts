// Installing a release here, as `pnpm run deploy` would: its build (the release workflow's `BUNDLE`, checked against
// the SHA-256 GitHub keeps of it), its new migrations through D1's API, then its static assets and the worker through
// Workers' API, keeping every binding, secret, route and setting the worker has. A release that needs a deploy (one
// adding a binding, or changing the SymCache builder where it runs) is refused, with why.
import { getSetting, setSetting } from '@/data/settings'
import { update as newest, type Update } from './check'

/** The owner's Cloudflare API token and where it found this worker: `{ token, account, script, database }` */
export const CONNECTION_KEY = 'update.cloudflare'
/** Whether the daily check installs a newer release on its own */
export const AUTO_KEY = 'update.auto'
/** The release installed here last, `{ version, at }`: `scripts/deploy-guard.mjs` refuses to deploy an older one */
export const INSTALLED_KEY = 'update.installed'
/** The daily check's last failure, `{ version, message, at }`, cleared by an install */
export const FAILED_KEY = 'update.failed'

export type Connection = { token: string; account: string; script: string; database: string }

/** What `scripts/release-bundle.mjs` packs: dist/ as built from wrangler.jsonc alone, and the migrations */
export type Bundle = {
  version: string
  worker: {
    main: string
    compatibility_date: string
    compatibility_flags: string[]
    crons: string[]
    assets: Record<string, unknown>
    /** The names of the bindings it needs */
    bindings: string[]
  }
  /** dist/server and dist/client, each file in base64 by its path */
  server: Record<string, string>
  client: Record<string, string>
  /** Each migration's SQL by its file name */
  migrations: Record<string, string>
}

type Binding = { type: string; name: string; id?: string }
type Settings = { bindings: Binding[] } & Record<string, unknown>

const API = 'https://api.cloudflare.com/client/v4'

async function cf<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  })
  const body = (await response.json().catch(() => null)) as {
    success: boolean
    errors?: { message: string }[]
    result: T
  } | null
  if (!body?.success) {
    const said = body?.errors?.map((e) => e.message).join(' ')
    throw new Error(`Cloudflare refused it${said ? `: ${said}` : ` with status ${response.status}`}.`)
  }
  return body.result
}
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/**
 * Finds `script` among the accounts `token` reaches and keeps the connection. The token needs Workers Scripts: Edit
 * and D1: Edit on that account
 */
export async function connect(db: D1Database, token: string, script: string, by: string) {
  const accounts = await cf<{ id: string }[]>(token, '/accounts').catch(() => {
    throw new Error('Cloudflare doesn’t take that token. Copy it again from the page that created it.')
  })
  for (const { id } of accounts) {
    const settings = await cf<Settings>(token, `/accounts/${id}/workers/scripts/${script}/settings`).catch(() => null)
    const database = settings?.bindings.find((b) => b.type === 'd1' && b.name === 'DB')?.id
    if (!database) continue
    await cf(token, `/accounts/${id}/d1/database/${database}`).catch(() => {
      throw new Error('That token can’t reach the database. Give it D1: Edit as well as Workers Scripts: Edit.')
    })
    const connection: Connection = { token, account: id, script, database }
    await setSetting(db, CONNECTION_KEY, connection, by)
    return { script }
  }
  throw new Error(
    `No Worker named ${script} is in reach of that token. Check the name, and that the token has Workers Scripts: Edit.`,
  )
}

const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (data: BufferSource | string) =>
  hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data))
const extension = (path: string) => /\.([^./]+)$/.exec(path)?.[1] ?? ''

// ponytail: the types dist/client has, the rest served as bytes; a map package if that grows
const TYPES: Record<string, string> = {
  js: 'application/javascript',
  css: 'text/css',
  html: 'text/html',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  png: 'image/png',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  txt: 'text/plain',
}

/** The release's build, if GitHub's SHA-256 of it is what came */
export async function download(update: Update): Promise<Bundle> {
  if (!update.bundle) throw new Error(`crashyard ${update.version} has no build to install. Update it with a deploy.`)
  const response = await fetch(update.bundle.url, { headers: { 'user-agent': 'crashyard' } })
  if (!response.ok) throw new Error(`GitHub didn’t send crashyard ${update.version}. Try again in a few minutes.`)
  const gzip = await response.arrayBuffer()
  if (`sha256:${await sha256(gzip)}` !== update.bundle.digest)
    throw new Error(`The download of crashyard ${update.version} isn’t the one GitHub lists. Nothing was changed.`)
  const bundle = (await new Response(
    new Blob([gzip]).stream().pipeThrough(new DecompressionStream('gzip')),
  ).json()) as Bundle
  if (bundle.version !== update.version)
    throw new Error(`The build of crashyard ${update.version} says it is ${bundle.version}. Nothing was changed.`)
  return bundle
}

/** Why this release needs a deploy instead, or null when it can be installed here */
export function refusal(update: Update, bundle: Bundle | null, settings: Settings | null, builder: boolean) {
  if (!update.bundle) return `crashyard ${update.version} has no build to install. Update it with a deploy.`
  if (update.builder && builder)
    return 'This update changes the SymCache builder. Its image is built on deploy, so update with a deploy, with Docker running.'
  if (bundle && settings) {
    const have = new Set(settings.bindings.map((b) => b.name))
    const missing = bundle.worker.bindings.filter((name) => !have.has(name))
    if (missing.length)
      return `This update adds ${missing.join(', ')}, which a deploy creates. Update it with a deploy.`
  }
  return null
}

/** Installs `update` with the saved connection, then records it; throws, having changed nothing, when it can't */
export async function install(env: Env, update: Update, now: number) {
  const c = await getSetting<Connection | null>(env.DB, CONNECTION_KEY, null)
  if (!c) throw new Error('Connect a Cloudflare API token first.')
  const script = `/accounts/${c.account}/workers/scripts/${c.script}`
  const [bundle, settings] = await Promise.all([download(update), cf<Settings>(c.token, `${script}/settings`)])
  const refused = refusal(update, bundle, settings, !!env.SYMCACHE_BUILDER)
  if (refused) throw new Error(refused)

  // The migrations it adds, as wrangler applies them: each one's SQL, then its row in `d1_migrations`
  const applied = await env.DB.prepare('SELECT name FROM d1_migrations')
    .all<{ name: string }>()
    .then((r) => new Set(r.results.map((m) => m.name)))
  for (const name of Object.keys(bundle.migrations).sort()) {
    if (applied.has(name)) continue
    const sql = `${bundle.migrations[name]}\nINSERT INTO d1_migrations (name) VALUES ('${name.replace(/'/g, "''")}');`
    await cf(c.token, `/accounts/${c.account}/d1/database/${c.database}/query`, json({ sql }))
  }

  // The static assets: a manifest of each one's hash, then those Cloudflare doesn't have yet, in its buckets
  const manifest: Record<string, { hash: string; size: number }> = {}
  const byHash = new Map<string, string>()
  for (const [path, base64] of Object.entries(bundle.client)) {
    const hash = (await sha256(base64 + extension(path))).slice(0, 32)
    manifest[`/${path}`] = { hash, size: atob(base64).length }
    byHash.set(hash, path)
  }
  const session = await cf<{ jwt: string; buckets?: string[][] }>(
    c.token,
    `${script}/assets-upload-session`,
    json({ manifest }),
  )
  let completion = session.jwt
  for (const bucket of session.buckets ?? []) {
    const form = new FormData()
    for (const hash of bucket) {
      const path = byHash.get(hash)!
      form.append(hash, new File([bundle.client[path]], hash, { type: TYPES[extension(path)] ?? 'application/null' }))
    }
    const done = await cf<{ jwt?: string }>(session.jwt, `/accounts/${c.account}/workers/assets/upload?base64=true`, {
      method: 'POST',
      body: form,
    })
    if (done.jwt) completion = done.jwt
  }

  // The worker: its modules, its compatibility, and every binding and setting it has now
  const form = new FormData()
  const keep = ['logpush', 'observability', 'placement', 'tail_consumers'] as const
  const metadata = {
    main_module: bundle.worker.main,
    compatibility_date: bundle.worker.compatibility_date,
    compatibility_flags: bundle.worker.compatibility_flags,
    bindings: [],
    keep_bindings: [...new Set(settings.bindings.map((b) => b.type))],
    assets: { jwt: completion, config: bundle.worker.assets },
    // As wrangler sends it, or the builder's Durable Object would lose its container
    ...(env.SYMCACHE_BUILDER && { containers: [{ class_name: 'SymcacheBuilder' }] }),
    annotations: { 'workers/message': `crashyard ${update.version}`, 'workers/tag': `v${update.version}` },
    ...Object.fromEntries(keep.filter((k) => settings[k] != null).map((k) => [k, settings[k]])),
  }
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  for (const [path, base64] of Object.entries(bundle.server)) {
    const type = path.endsWith('.wasm') ? 'application/wasm' : 'application/javascript+module'
    form.append(path, new File([bytes(base64)], path, { type }))
  }
  await cf(c.token, script, { method: 'PUT', body: form })

  const schedules = await cf<{ schedules: { cron: string }[] }>(c.token, `${script}/schedules`)
  const crons = schedules.schedules.map((s) => s.cron)
  if (crons.join() !== bundle.worker.crons.join())
    await cf(c.token, `${script}/schedules`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bundle.worker.crons.map((cron) => ({ cron }))),
    })

  await setSetting(env.DB, INSTALLED_KEY, { version: update.version, at: now }, null, now)
  await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(FAILED_KEY).run()
}

/** The daily check, where an owner turned it on: the newest release installed, never a new major version. A failure is
 *  kept for the dashboard to show */
export async function autoUpdate(env: Env, now: number) {
  if (!(await getSetting(env.DB, AUTO_KEY, false))) return
  const update = await newest()
  if (!update || update.major) return
  try {
    await install(env, update, now)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await setSetting(env.DB, FAILED_KEY, { version: update.version, message, at: now }, null, now)
    throw error
  }
}
