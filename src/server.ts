import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { env } from 'cloudflare:workers'
import { viewerOf } from './auth/access'

const start = createStartHandler(defaultStreamHandler)

// Paths apps and build tools call, each checking its own key or token; everything else is the dashboard, behind Access
const open = (path: string) => path.startsWith('/api/')

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (open(url.pathname)) return start(request)
    const viewer = await viewerOf(request, env, import.meta.env.DEV)
    if (!viewer) return new Response('Sign in through Cloudflare Access to open crashyard.', { status: 403 })
    // The dashboard reads who's signed in from this header; one sent from outside is replaced
    const headers = new Headers(request.headers)
    headers.set('x-crashyard-viewer', viewer.email)
    return start(new Request(request, { headers }))
  },

  async scheduled(_controller: ScheduledController): Promise<void> {
    // Uptime checks, missed check-ins and the daily jobs come with their phases
  },
}
