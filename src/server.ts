import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { env as workerEnv } from 'cloudflare:workers'
import { handleAction } from './api/actions'
import { handleIngest } from './api/ingest'
import { viewerOf } from './auth/access'

const start = createStartHandler(defaultStreamHandler)

// What apps and build tools call: plain handlers, each checking its own key or token, ahead of Start
const INGEST = /^\/api\/(\d+)\/(envelope|store)\/?$/
const ACTION = /^\/api\/actions\/(\d+)\/(resolve|ignore)\/?$/

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const ingest = url.pathname.match(INGEST)
    if (ingest) return handleIngest(request, env, ctx, Number(ingest[1]), ingest[2] as 'envelope' | 'store')
    const action = url.pathname.match(ACTION)
    if (action) return handleAction(request, env, Number(action[1]), action[2] as 'resolve' | 'ignore')
    // Local dev only (compiled out of every build): SQL for the end-to-end tests, so only this process opens the
    // local database (a second one on the same file trips over its locks)
    if (import.meta.env.DEV && url.pathname === '/__dev/sql' && request.method === 'POST') {
      const statements = (await request.json()) as { sql: string; params: unknown[] }[]
      const results = await env.DB.batch(statements.map((s) => env.DB.prepare(s.sql).bind(...s.params)))
      return Response.json(results)
    }
    if (url.pathname.startsWith('/api/0/')) {
      const [{ handleSentryApi }, { freshSymbolic, sharedSymbolic }, { reprocess }] = await Promise.all([
        import('./api/sentry'),
        import('./symbols/module'),
        import('./symbols/reprocess'),
      ])
      return handleSentryApi(request, {
        env,
        ctx,
        symbolic: freshSymbolic,
        reprocess: (projectId, debugIds) => reprocess(env, sharedSymbolic, projectId, debugIds),
      })
    }
    if (url.pathname.startsWith('/api/')) return Response.json({ detail: 'Not found' }, { status: 404 })

    // Everything else is the dashboard, behind Access
    const viewer = await viewerOf(request, workerEnv, import.meta.env.DEV)
    if (!viewer) return new Response('Sign in through Cloudflare Access to open crashyard.', { status: 403 })
    if (url.pathname === '/mcp') {
      const { handleMcp } = await import('./api/mcp')
      return handleMcp(request, env.DB, viewer.email)
    }
    // The dashboard reads who's signed in from this header; one sent from outside is replaced
    const headers = new Headers(request.headers)
    headers.set('x-crashyard-viewer', viewer.email)
    return start(new Request(request, { headers }))
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const { flushHeld } = await import('./notify/dispatch')
    await flushHeld(env)
    // Once a day, at 03:00 UTC: events and logs past their project's retention
    const at = new Date(controller.scheduledTime)
    if (at.getUTCHours() === 3 && at.getUTCMinutes() === 0) {
      const [{ pruneEvents }, { pruneLogs }] = await Promise.all([import('./data/projects'), import('./data/logs')])
      await pruneEvents(env.DB, controller.scheduledTime)
      await pruneLogs(env.DB, controller.scheduledTime)
    }
  },
}
