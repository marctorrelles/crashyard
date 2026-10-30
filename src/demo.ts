// The public demo, demo.crashyard.dev: on only where the deployment's vars set DEMO=1. Read-only for everyone, no
// accounts (src/auth/AGENTS.md, Demo). A self-hoster never sets it, and then nothing here runs
import { nextPath } from './lib/next'
import type { Who } from './auth/session'

export const isDemo = (env: { DEMO?: string }) => env.DEMO === '1'

/** Everyone in the demo: one viewer, with no user row and no session */
export const DEMO_VIEWER = { email: 'visitor@demo.crashyard.dev', role: 'viewer' } as const satisfies Who
export const DEMO_COOKIE = 'crashyard_demo'
export const DEMO_REFUSAL = 'This is a demo, so nothing here changes. Deploy your own crashyard to try it.'
export const DEMO_INGEST = 'This crashyard is a demo and doesn’t take events. Deploy your own to send yours.'

/** Whether a server function is refused (src/fns.ts `as`): in the demo, every one not marked read-only, for any role */
export const demoRefuses = (env: { DEMO?: string }, readOnly: boolean) => isDemo(env) && !readOnly

const cookie = (value: string, maxAge: number, secure: boolean) =>
  `${DEMO_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`

/**
 * What demo mode answers ahead of the rest of src/server.ts, or null to go on: ingest closed before the body is read,
 * every sign-in way closed but Enter demo and Leave demo, `/setup` and invites sent to `/signin`, and `/mcp` without
 * an agent token as the demo's viewer
 */
export async function demoGate(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname
  const secure = url.protocol === 'https:'
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
    return handleMcp(request, env.DB, DEMO_VIEWER, DEMO_REFUSAL)
  }
  return null
}
