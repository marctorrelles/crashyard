import { WorkerEntrypoint } from 'cloudflare:workers'
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

// What the demo's feeder (crashyard-demo/feeder) sends through a service binding only: a named entrypoint isn't
// reachable from the internet, and ingest's own doors are closed in the demo (src/demo.ts). Each goes through ingest's
// own path at the time it says it was received. Refuses unless DEMO is set, so a self-hoster's deployment, which never
// binds it, can't use it either. Keep `send`'s input stable: add to it, never change it
export class DemoFeed extends WorkerEntrypoint<Env> {
  /** The status ingest answered: 403 outside the demo, 404 for a project or key that isn't there, 400 for a time
   *  ahead of now */
  async send(input: FeedInput): Promise<number> {
    return (await feed(this.env, this.ctx, input)).status
  }
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
