import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { handleIngest } from './api/ingest'
import { whoIs } from './auth/session'
import type { Notice } from './notify/notice'

const start = createStartHandler(defaultStreamHandler)

// What apps and build tools call: plain handlers, each checking its own key or token, ahead of Start. Ingest: an
// envelope, an event, a security report, or a check-in over HTTP (`cron/<slug>/<key>`, the key optional)
// crashyard's own sign-in pages, open while signed out (src/auth/AGENTS.md)
const SIGN_IN_PAGES = /^\/(signin|setup|invite\/[^/]+)\/?$/
// A project's public status page, open to anyone (src/routes/status.$slug.tsx): a GET only, its data read in the render
const STATUS_PAGE = /^\/status\/[a-z0-9][a-z0-9-]*\/?$/

/** A request's headers without the `x-crashyard-` ones, which only this file sets */
function outsideHeaders(request: Request) {
  const headers = new Headers()
  for (const [name, value] of request.headers) if (!name.startsWith('x-crashyard-')) headers.append(name, value)
  return headers
}

const INGEST = /^\/api\/(\d+)\/(envelope|store|security|cron)((?:\/[^/]+){0,2})\/?$/

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const ingest = url.pathname.match(INGEST)
    if (ingest)
      return handleIngest(
        request,
        env,
        ctx,
        Number(ingest[1]),
        ingest[2] as 'envelope' | 'store' | 'security' | 'cron',
        ingest[3].split('/').filter(Boolean),
      )
    // Local dev only (compiled out of every build): SQL for the end-to-end tests, so only this process opens the
    // local database (a second one on the same file trips over its locks)
    if (import.meta.env.DEV && url.pathname === '/__dev/sql' && request.method === 'POST') {
      const statements = (await request.json()) as { sql: string; params: unknown[] }[]
      const results = await env.DB.batch(statements.map((s) => env.DB.prepare(s.sql).bind(...s.params)))
      return Response.json(results)
    }
    if (import.meta.env.DEV && url.pathname === '/__dev/tail' && request.method === 'POST') {
      const { handleTail } = await import('./api/tail')
      await handleTail((await request.json()) as TraceItem[], env, ctx)
      return Response.json({})
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
    // A Telegram bot's buttons, checked by the secret saving its channel gave Telegram (src/api/telegram.ts)
    const telegram = url.pathname.match(/^\/api\/telegram\/(\d+)\/?$/)
    if (telegram) {
      const { handleTelegram } = await import('./api/telegram')
      return handleTelegram(request, env.DB, telegram[1])
    }
    if (url.pathname.startsWith('/api/')) return Response.json({ detail: 'Not found' }, { status: 404 })

    // A project's own domain for its status page (Monitors, Status pages): that page alone, as to someone signed out
    if (!env.PUBLIC_URL || url.hostname !== new URL(env.PUBLIC_URL).hostname) {
      const { slugOfDomain } = await import('./data/status')
      const slug = await slugOfDomain(env.DB, url.hostname, Date.now())
      if (slug) {
        const page = `/status/${slug}`
        if (request.method === 'GET' && url.pathname === '/') return Response.redirect(new URL(page, url), 302)
        if (request.method !== 'GET' || url.pathname.replace(/\/$/, '') !== page)
          return new Response('Not found', { status: 404 })
        return start(new Request(request, { headers: outsideHeaders(request) }))
      }
    }

    // Everything else is the dashboard: signed in with a passkey, or with GitHub
    const now = Date.now()
    const who = await whoIs(request, env, import.meta.env.DEV, now)
    const github = url.pathname.match(/^\/auth\/github\/(\w+)$/)
    if (github && request.method === 'GET') {
      const [{ handleGitHub }, { relyingParty }] = await Promise.all([
        import('./auth/github'),
        import('./auth/passkeys'),
      ])
      const { origin } = relyingParty(request, env, import.meta.env.DEV)
      const answer = await handleGitHub(github[1], { request, db: env.DB, base: origin, who, now })
      if (answer) return answer
    }
    if (url.pathname.startsWith('/auth/')) {
      const { handleAuth } = await import('./auth/passkeys')
      const answer = await handleAuth(url.pathname.slice('/auth/'.length), {
        request,
        env,
        dev: import.meta.env.DEV,
        who,
        now,
      })
      if (answer) return answer
    }
    // An agent with its person's token (Settings, Agent tokens), on /mcp only
    const bearer = request.headers.get('Authorization')?.match(/^Bearer (cyp_\S+)$/)?.[1]
    if (url.pathname === '/mcp' && bearer) {
      const [{ handleMcp }, people] = await Promise.all([import('./api/mcp'), import('./data/people')])
      const token = await people.userTokenOf(env.DB, bearer, now)
      if (!token)
        return new Response('That agent token isn’t valid anymore. Create a new one in Settings.', { status: 401 })
      return handleMcp(request, env.DB, {
        email: token.user.email,
        role: people.tokenRole(token.user.role, token.scope),
      })
    }
    // The sign-in pages are open to anyone, and only to someone signed out
    const signInPage = SIGN_IN_PAGES.test(url.pathname)
    if (signInPage && who) return Response.redirect(new URL('/', url), 303)
    const statusPage = request.method === 'GET' && STATUS_PAGE.test(url.pathname)
    if (!who && !signInPage && !statusPage) {
      if (url.pathname === '/mcp' || url.pathname.startsWith('/_serverFn') || request.method !== 'GET')
        return new Response('Sign in to crashyard first.', { status: 401 })
      const { userCount } = await import('./data/people')
      const to = (await userCount(env.DB))
        ? `/signin${url.pathname === '/' ? '' : `?next=${encodeURIComponent(url.pathname + url.search)}`}`
        : '/setup'
      return Response.redirect(new URL(to, url), 303)
    }
    if (url.pathname === '/mcp' && who) {
      const { handleMcp } = await import('./api/mcp')
      return handleMcp(request, env.DB, who)
    }
    // The dashboard reads who's signed in from these headers only; any sent from outside are dropped
    const headers = outsideHeaders(request)
    if (who) {
      headers.set('x-crashyard-viewer', who.email)
      headers.set('x-crashyard-role', who.role)
      if (who.userId) headers.set('x-crashyard-user', String(who.userId))
      if (who.session) headers.set('x-crashyard-session', who.session)
    }
    const response = await start(new Request(request, { headers }))
    if (!who?.cookie) return response
    const renewed = new Response(response.body, response)
    renewed.headers.append('Set-Cookie', who.cookie)
    return renewed
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await everyMinute(env, controller.scheduledTime)
  },

  // Runs of the Workers that name crashyard in their `tail_consumers` (src/api/tail.ts)
  async tail(items: TraceItem[], env: Env, ctx: ExecutionContext): Promise<void> {
    const { handleTail } = await import('./api/tail')
    await handleTail(items, env, ctx)
  },
}

/** The cron's whole run, shared by its jobs: each takes what's left, and one with under 2 seconds waits a minute */
const CRON_BUDGET = 40_000
const MIN_LEFT = 2_000

// The cron: its heartbeat, monitors (missed check-ins, uptime checks), held notifications, every 5 minutes (at :02,
// :07…), metric alerts, and hourly, escalation, retention and auto-resolve, then envelopes to try again, last. Each
// job is on its own: one that throws doesn't stop the others. They share one deadline, 40 seconds from the start
async function everyMinute(env: Env, now: number) {
  const at = new Date(now)
  const deadline = Date.now() + CRON_BUDGET
  const job = async (name: string, run: () => Promise<unknown>) => {
    if (deadline - Date.now() < MIN_LEFT) {
      console.warn(`cron: ${name} skipped, out of time until the next minute`)
      return
    }
    try {
      await run()
    } catch (error) {
      console.error(`cron: ${name} failed`, error)
    }
  }
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
  // Every 5 minutes, at :02, :07…, off the hourly jobs' minutes: metric alerts, a notice only when one changes state
  if (at.getUTCMinutes() % 5 === 2)
    await job('metric alerts', async () => {
      const { evaluateMetricAlerts } = await import('./notify/metrics')
      notices.push(...(await evaluateMetricAlerts(env, now, deadline)))
    })
  // Hourly, at :25: issues escalating in the hour just ended
  if (at.getUTCMinutes() === 25)
    await job('escalation', async () => {
      const { checkEscalation } = await import('./data/escalation')
      notices.push(...(await checkEscalation(env.DB, env.PUBLIC_URL ?? '', now, deadline)))
    })
  const { dispatch, flushHeld, pruneFailures } = await import('./notify/dispatch')
  await job('notifications', () => dispatch(env, notices, now))
  await job('held notifications', () => flushHeld(env, now))
  // Hourly, at :15: events, attachments, issues, logs, transactions, check-ins and uptime results past their
  // retention; what's left goes the next hour
  if (at.getUTCMinutes() === 15) {
    const [{ pruneEvents }, { pruneLogs }, { pruneMonitors }, { prunePerformance }] = await Promise.all([
      import('./data/projects'),
      import('./data/logs'),
      import('./monitors/monitors'),
      import('./data/performance'),
    ])
    await job('event retention', () => pruneEvents(env.DB, now, env.FILES, deadline))
    await job('log retention', () => pruneLogs(env.DB, now, deadline))
    await job('performance retention', () => prunePerformance(env.DB, now))
    await job('monitor retention', () => pruneMonitors(env.DB, now))
  }
  // Hourly, at :20: sessions and passkey challenges past their end, issues not seen for their project's "Resolve issues
  // not seen for", and notification failures past 30 days
  if (at.getUTCMinutes() === 20) {
    await job('sign-in', async () => (await import('./data/people')).pruneSignIn(env.DB, now))
    await job('auto-resolve', async () => (await import('./data/issues')).autoResolve(env.DB, now, deadline))
    await job('notification failures', () => pruneFailures(env.DB, now))
  }
  // Last, with what time is left: envelopes that failed in their request, tried again
  await job('retries', async () => (await import('./ingest/retry')).retryPending(env, now, deadline))
}
