import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { env as workerEnv } from 'cloudflare:workers'
import { handleIngest } from './api/ingest'
import { viewerOf } from './auth/access'
import type { Notice } from './notify/notice'

const start = createStartHandler(defaultStreamHandler)

// What apps and build tools call: plain handlers, each checking its own key or token, ahead of Start
const INGEST = /^\/api\/(\d+)\/(envelope|store)\/?$/

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const ingest = url.pathname.match(INGEST)
    if (ingest) return handleIngest(request, env, ctx, Number(ingest[1]), ingest[2] as 'envelope' | 'store')
    // Local dev only (compiled out of every build): SQL for the end-to-end tests, so only this process opens the
    // local database (a second one on the same file trips over its locks)
    if (import.meta.env.DEV && url.pathname === '/__dev/sql' && request.method === 'POST') {
      const statements = (await request.json()) as { sql: string; params: unknown[] }[]
      const results = await env.DB.batch(statements.map((s) => env.DB.prepare(s.sql).bind(...s.params)))
      return Response.json(results)
    }
    if (import.meta.env.DEV && url.pathname === '/__dev/cron' && request.method === 'POST') {
      await everyMinute(env, Number(url.searchParams.get('now')) || Date.now())
      return Response.json({})
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
    await everyMinute(env, controller.scheduledTime)
  },
}

// The cron: its heartbeat, monitors (missed check-ins, uptime checks), held notifications, envelopes to try again,
// every 5 minutes, metric alerts, and hourly, escalation, retention and auto-resolve. Each job is on its own: one that throws doesn't stop the others
async function everyMinute(env: Env, now: number) {
  const at = new Date(now)
  const notices: Notice[] = []
  // Settings, Health shows the cron as late when this is over 3 minutes old
  await job('heartbeat', async () => {
    const { CRON_KEY, setSetting } = await import('./data/settings')
    await setSetting(env.DB, CRON_KEY, now, null, now)
  })
  await job('monitors', async () => {
    const { runMonitors } = await import('./monitors/monitors')
    notices.push(...(await runMonitors(env, now)))
  })
  // Hourly, at :05: transactions that got slower in a release
  if (at.getUTCMinutes() === 5)
    await job('slower releases', async () => {
      const { checkSlowerReleases } = await import('./data/performance')
      notices.push(...(await checkSlowerReleases(env.DB, env.PUBLIC_URL ?? '', now)))
    })
  // Mondays at 07:00 UTC: each project's week
  if (at.getUTCDay() === 1 && at.getUTCHours() === 7 && at.getUTCMinutes() === 0)
    await job('weekly summaries', async () => {
      const { weeklySummaries } = await import('./data/projects')
      notices.push(...(await weeklySummaries(env.DB, env.PUBLIC_URL ?? '', now)))
    })
  // Every 5 minutes: metric alerts, a notice only when one changes state
  if (at.getUTCMinutes() % 5 === 0)
    await job('metric alerts', async () => {
      const { evaluateMetricAlerts } = await import('./notify/metrics')
      notices.push(...(await evaluateMetricAlerts(env, now)))
    })
  // Hourly, at :25: issues escalating in the hour just ended, within 20 seconds
  if (at.getUTCMinutes() === 25)
    await job('escalation', async () => {
      const { checkEscalation } = await import('./data/escalation')
      notices.push(...(await checkEscalation(env.DB, env.PUBLIC_URL ?? '', now)))
    })
  const { dispatch, flushHeld, pruneFailures } = await import('./notify/dispatch')
  await job('notifications', () => dispatch(env, notices, now))
  await job('held notifications', () => flushHeld(env, now))
  // Envelopes that failed in their request, tried again
  await job('retries', async () => (await import('./ingest/retry')).retryPending(env, now))
  // Hourly, at :15: events, attachments, issues, logs, transactions, check-ins and uptime results past their retention,
  // within 20 seconds together; what's left goes the next hour
  if (at.getUTCMinutes() === 15) {
    const [{ pruneEvents, PRUNE_BUDGET }, { pruneLogs }, { pruneMonitors }, { prunePerformance }] = await Promise.all([
      import('./data/projects'),
      import('./data/logs'),
      import('./monitors/monitors'),
      import('./data/performance'),
    ])
    const deadline = Date.now() + PRUNE_BUDGET
    await job('event retention', () => pruneEvents(env.DB, now, env.FILES, deadline))
    await job('log retention', () => pruneLogs(env.DB, now, deadline))
    await job('performance retention', () => prunePerformance(env.DB, now))
    await job('monitor retention', () => pruneMonitors(env.DB, now))
  }
  // Hourly, at :20: issues not seen for their project's "Resolve issues not seen for", within 20 seconds; and
  // notification failures past 30 days
  if (at.getUTCMinutes() === 20) {
    await job('auto-resolve', async () => (await import('./data/issues')).autoResolve(env.DB, now))
    await job('notification failures', () => pruneFailures(env.DB, now))
  }
}

async function job(name: string, run: () => Promise<unknown>) {
  try {
    await run()
  } catch (error) {
    console.error(`cron: ${name} failed`, error)
  }
}
