// The public demo, demo.crashyard.dev: on only where the deployment's vars set DEMO=1. Read-only for everyone, no
// accounts (src/auth/AGENTS.md, Demo). A self-hoster never sets it, and then nothing here runs
import { nextPath } from './lib/next'
import type { Who } from './auth/session'

export const isDemo = (env: { DEMO?: string }) => env.DEMO === '1'

/** Everyone in the demo: one viewer, with no user row and no session. An owner, so every page shows: `as()` in
 * src/fns.ts refuses its changes whatever the role */
export const DEMO_VIEWER = { email: 'visitor@demo.crashyard.dev', role: 'owner' } as const satisfies Who
export const DEMO_COOKIE = 'crashyard_demo'
export const DEMO_REFUSAL = 'This is a demo, so nothing here changes. Deploy your own crashyard to try it.'
export const DEMO_INGEST = 'This crashyard is a demo and doesn’t take events. Deploy your own to send yours.'

/** Whether a server function is refused (src/fns.ts `as`): in the demo, every one not marked read-only, for any role */
export const demoRefuses = (env: { DEMO?: string }, readOnly: boolean) => isDemo(env) && !readOnly

const cookie = (value: string, maxAge: number, secure: boolean) =>
  `${DEMO_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`

/**
 * What demo mode answers ahead of the rest of src/server.ts, or null to go on: the feeder's `/__feed` (src/api/feed.ts),
 * ingest closed before the body is read,
 * every sign-in way closed but Enter demo and Leave demo, `/setup` and invites sent to `/signin`, and `/mcp` without
 * an agent token as the demo's viewer
 */
export async function demoGate(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname
  const secure = url.protocol === 'https:'
  if (path === '/__feed') {
    const { handleFeed } = await import('./api/feed')
    return handleFeed(request, env, ctx)
  }
  const { CORS, INGEST } = await import('./api/ingest')
  if (INGEST.test(path))
    return request.method === 'OPTIONS'
      ? new Response(null, { status: 204, headers: CORS })
      : Response.json({ detail: DEMO_INGEST }, { status: 403, headers: CORS })
  if (path === '/auth/demo' || path === '/auth/signout') {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
    if (request.headers.get('Origin') !== url.origin)
      return Response.json({ error: 'Open crashyard and try again from there.' }, { status: 403 })
    if (path === '/auth/signout')
      return new Response(null, { status: 303, headers: { Location: '/signin', 'Set-Cookie': cookie('', 0, secure) } })
    const form = await request.formData().catch(() => null)
    return new Response(null, {
      status: 303,
      headers: { Location: nextPath(form?.get('next') ?? '/'), 'Set-Cookie': cookie('1', 86_400, secure) },
    })
  }
  if (path.startsWith('/auth/')) return new Response('Not found', { status: 404 })
  if (/^\/(setup|invite\/[^/]+)\/?$/.test(path)) return Response.redirect(new URL('/signin', url), 303)
  if (path === '/mcp' && !/^Bearer cyp_\S+$/.test(request.headers.get('Authorization') ?? '')) {
    const { handleMcp } = await import('./api/mcp')
    // As a viewer: MCP refuses changes by role, below member, with the demo's sentence
    return handleMcp(request, env.DB, { ...DEMO_VIEWER, role: 'viewer' }, DEMO_REFUSAL)
  }
  return null
}

// The cookies server functions read: the theme and style, the browser's time zone, the project picked last, the
// sidebar folded. Every visitor is the same viewer, so these are all that tells one answer from another
const VARIES = ['theme', 'style', 'tz', 'crashyard_project', 'sidebar_state']

/** What a server function's answer is kept under: its URL, with the values of the cookies it can read */
export function demoCacheKey(request: Request) {
  const cookies = new Map(
    (request.headers.get('Cookie') ?? '')
      .split(/;\s*/)
      .map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]),
  )
  const key = new URL(request.url)
  key.searchParams.set('__demo', VARIES.map((name) => `${name}=${cookies.get(name) ?? ''}`).join(';'))
  return key.toString()
}

/**
 * A GET server function in the demo, kept a minute in the data centre's cache: everyone is one viewer and the data
 * changes a minute at a time, so a crowd reads D1 once a minute per call instead of once a visit. Navigating in the
 * dashboard only: a first page, rendered on the server, still reads D1. The Cache API does nothing on workers.dev
 */
export async function demoCache(request: Request, ctx: ExecutionContext, answer: () => Response | Promise<Response>) {
  const cache = (caches as unknown as { default: Cache }).default
  const key = new Request(demoCacheKey(request))
  const hit = await cache.match(key)
  if (hit) return fresh(hit, 'hit')
  const response = await answer()
  if (response.status !== 200 || response.headers.has('Set-Cookie')) return response
  const kept = new Response(response.body, response)
  kept.headers.set('Cache-Control', 'public, max-age=60')
  ctx.waitUntil(cache.put(key, kept.clone()))
  return fresh(kept, 'miss')
}

// The browser keeps none of it: its cookies can change under the same URL. A dev server says whether it was kept
function fresh(response: Response, how: 'hit' | 'miss') {
  const out = new Response(response.body, response)
  out.headers.set('Cache-Control', 'no-store')
  if (import.meta.env.DEV) out.headers.set('x-crashyard-demo-cache', how)
  return out
}
