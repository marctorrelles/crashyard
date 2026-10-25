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
    if (url.pathname.startsWith('/api/')) return Response.json({ detail: 'Not found' }, { status: 404 })

    // Everything else is the dashboard, behind Access
    const viewer = await viewerOf(request, workerEnv, import.meta.env.DEV)
    if (!viewer) return new Response('Sign in through Cloudflare Access to open crashyard.', { status: 403 })
    // The dashboard reads who's signed in from this header; one sent from outside is replaced
    const headers = new Headers(request.headers)
    headers.set('x-crashyard-viewer', viewer.email)
    return start(new Request(request, { headers }))
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const { flushHeld } = await import('./notify/dispatch')
    await flushHeld(env)
    // Once a day, at 03:00 UTC: events past their project's retention
    const at = new Date(controller.scheduledTime)
    if (at.getUTCHours() === 3 && at.getUTCMinutes() === 0) {
      const { pruneEvents } = await import('./data/projects')
      await pruneEvents(env.DB, controller.scheduledTime)
    }
  },
}
