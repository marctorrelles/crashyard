import { FORWARDED } from '../ingest/forward'
import { isDemo } from '../demo'
import { type Door, handleIngest } from './ingest'

/** What the demo's feeder sends: an envelope, event, report or check-in as an SDK sent it */
export type FeedInput = {
  project: string // the project's slug
  door: Door
  path?: string[] // a check-in's monitor slug; a key after it is dropped, the project's own is used
  query?: string // as recorded, such as a security report's sentry_release; sentry_key is replaced
  method?: 'GET' | 'POST' // POST unless a check-in was a GET
  headers?: Record<string, string> // content-type, user-agent: as recorded
  body: Uint8Array
  received: number // ms since 1970, not in the future
}

const ALLOWED_HEADERS = new Set(['content-type', 'content-encoding', 'user-agent'])

/** A FeedInput as JSON: its body in base64 */
export type FeedWire = Omit<FeedInput, 'body'> & { body: string }
const BATCH = 200

// What the demo's feeder (crashyard-demo/feeder) sends, through its service binding: POST /__feed (src/demo.ts), a
// JSON list of FeedWire, one scenario's envelopes in order, answered with each one's status (403 outside the demo, 404
// for a project or key that isn't there, 400 for a time ahead of now). An HTTP request, not RPC, so Smart Placement
// runs it beside D1: a store is several queries one after another. Behind FEED_SECRET, a secret both Workers have;
// without it the path isn't there. Ingest's own doors stay closed in the demo. Keep FeedWire stable: add to it
export async function handleFeed(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const notFound = new Response('Not found', { status: 404 })
  if (!env.FEED_SECRET || request.method !== 'POST') return notFound
  if (!(await same(request.headers.get('authorization') ?? '', `Bearer ${env.FEED_SECRET}`))) return notFound
  const inputs = (await request.json().catch(() => null)) as FeedWire[] | null
  if (!Array.isArray(inputs) || inputs.length > BATCH)
    return new Response(`Expected a list of up to ${BATCH} inputs`, { status: 400 })
  const statuses: number[] = []
  for (const input of inputs) {
    const body = Uint8Array.from(atob(String(input.body ?? '')), (c) => c.charCodeAt(0))
    statuses.push((await feed(env, ctx, { ...input, body })).status)
  }
  return Response.json(statuses)
}

// Compared as SHA-256 digests, every byte, so the time taken says nothing of the secret
async function same(a: string, b: string) {
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  const [x, y] = await Promise.all([digest(a), digest(b)])
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

export async function feed(env: Env, ctx: ExecutionContext, input: FeedInput): Promise<Response> {
  if (!isDemo(env)) return new Response('Only the demo takes a feed', { status: 403 })
  if (!Number.isFinite(input.received) || input.received > Date.now() + 1000)
    return new Response('received is in the future', { status: 400 })
  // The project and its first key that's on, as src/api/tail.ts finds them
  const project = await env.DB.prepare(
    `SELECT p.id, (SELECT k.public_key FROM project_keys k WHERE k.project_id = p.id AND k.enabled = 1
       ORDER BY k.id LIMIT 1) AS key
     FROM projects p WHERE p.slug = ?`,
  )
    .bind(input.project)
    .first<{ id: number; key: string | null }>()
  if (!project?.key) return new Response('No such project, or no key on', { status: 404 })
  const path = input.door === 'cron' ? (input.path ?? []).slice(0, 1) : []
  const url = new URL(
    `https://feed.crashyard/api/${project.id}/${input.door}/${path.map(encodeURIComponent).join('/')}`,
  )
  for (const [name, value] of new URLSearchParams(input.query ?? ''))
    if (name !== 'sentry_key') url.searchParams.append(name, value)
  const headers = new Headers(
    Object.entries(input.headers ?? {}).filter(([name]) => ALLOWED_HEADERS.has(name.toLowerCase())),
  )
  headers.set('x-sentry-auth', `Sentry sentry_version=7, sentry_key=${project.key}`)
  // Not forwarded to Sentry, and nothing in the demo would be
  headers.set(FORWARDED, 'feed')
  const method = input.door === 'cron' && input.method === 'GET' ? 'GET' : 'POST'
  const request = new Request(url, {
    method,
    headers,
    body: method === 'GET' ? undefined : (input.body as Uint8Array<ArrayBuffer>),
  })
  return handleIngest(request, env, ctx, project.id, input.door, path, input.received)
}
