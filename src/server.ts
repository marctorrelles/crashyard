import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { handleIngest, INGEST } from './api/ingest'
import { whoIs } from './auth/session'
import { demoCache, demoGate, isDemo } from './demo'
import type { Notice } from './notify/notice'

const start = createStartHandler(defaultStreamHandler)

// What apps and build tools call: plain handlers, each checking its own key or token, ahead of Start (ingest's doors:
// `INGEST`, src/api/ingest.ts)
// crashyard's own sign-in pages, open while signed out (src/auth/AGENTS.md)
const SIGN_IN_PAGES = /^\/(signin|setup|invite\/[^/]+)\/?$/
// A status page, open to anyone (src/routes/status.$slug.tsx): a GET only, its data read in the render
const STATUS_PAGE = /^\/status\/[a-z0-9][a-z0-9-]*\/?$/

/** A request's headers without the `x-crashyard-` ones, which only this file sets */
function outsideHeaders(request: Request) {
  const headers = new Headers()
  for (const [name, value] of request.headers) if (!name.startsWith('x-crashyard-')) headers.append(name, value)
  return headers
}

/**
 * A status page as anyone signed out sees it, kept a minute in the data centre's cache: each render reads 30 days of
 * results for every check on it, and the page reloads itself each minute, so open tabs and visitors would otherwise
 * read that again and again. Only for a visitor without cookies (theirs carry no theme or time zone of their own),
 * rendered with none (`outsideHeaders`). The Cache API does nothing on workers.dev
 */
async function publicStatusPage(request: Request, ctx: ExecutionContext) {
  const cache = (caches as unknown as { default: Cache }).default
  const cacheable = !request.headers.has('Cookie')
  const key = new Request(request.url)
  if (cacheable) {
    const hit = await cache.match(key)
    if (hit) return hit
  }
  const response = await start(new Request(request, { headers: outsideHeaders(request) }))
  if (!cacheable || response.status !== 200) return response
  const kept = new Response(response.body, response)
  kept.headers.set('Cache-Control', 'public, max-age=60')
  ctx.waitUntil(cache.put(key, kept.clone()))
  return kept
}

// The SymCache builder's Durable Object, bound only where wrangler.local.json adds its container
export { SymcacheBuilder } from './symbols/builder'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // The public demo only (DEMO=1): ingest and sign-in closed, before anything else (src/demo.ts)
    if (isDemo(env)) {
      const answer = await demoGate(request, env)
      if (answer) return answer
    }
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
        // One builder for the deployment, so uploads take turns in its container
        build: env.SYMCACHE_BUILDER
          ? (path, body, size) =>
              env
                .SYMCACHE_BUILDER!.get(env.SYMCACHE_BUILDER!.idFromName('builder'))
                .fetch(`http://builder${path}`, { method: 'POST', body, headers: { 'content-length': String(size) } })
          : undefined,
        // After the answer, in waitUntil: a failure would vanish unlogged
        reprocess: (projectId, debugIds) =>
          reprocess(env, sharedSymbolic, projectId, debugIds).catch((error) =>
            console.error(`reprocess: project ${projectId} failed`, error),
          ),
      })
    }
    // A Telegram bot's buttons, checked by the secret saving its channel gave Telegram (src/api/telegram.ts)
    const telegram = url.pathname.match(/^\/api\/telegram\/(\d+)\/?$/)
    if (telegram) {
      const { handleTelegram } = await import('./api/telegram')
      return handleTelegram(request, env.DB, telegram[1])
    }
    if (url.pathname.startsWith('/api/')) return Response.json({ detail: 'Not found' }, { status: 404 })

    // A status page's own domain (Monitors, Status pages): that page alone, as to someone signed out
    if (!env.PUBLIC_URL || url.hostname !== new URL(env.PUBLIC_URL).hostname) {
      const { slugOfDomain } = await import('./data/status')
      const slug = await slugOfDomain(env.DB, url.hostname, Date.now())
      if (slug) {
        const page = `/status/${slug}`
        if (request.method === 'GET' && url.pathname === '/') return Response.redirect(new URL(page, url), 302)
        if (request.method !== 'GET' || url.pathname.replace(/\/$/, '') !== page)
          return new Response('Not found', { status: 404 })
        return publicStatusPage(request, ctx)
      }
    }
    // A status page for a visitor with no cookies: the same for all of them, so cached a minute
    if (request.method === 'GET' && STATUS_PAGE.test(url.pathname) && !request.headers.has('Cookie'))
      return publicStatusPage(request, ctx)

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
      // The demo has no one to set up: its front door is /signin
      const to =
        isDemo(env) || (await userCount(env.DB))
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
    // The demo's one viewer gets the same answers: a server function's is kept a minute (src/demo.ts)
    if (isDemo(env) && who && request.method === 'GET' && url.pathname.startsWith('/_serverFn/')) {
      return demoCache(request, ctx, () => start(new Request(request, { headers })))
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

const MINUTE = 60_000
const HOUR = 60 * MINUTE

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
  // A job of an hour or a week runs once in it, from its minute on: a minute Cloudflare skipped or ran late is made up
  // by the next, within `grace` (a first deploy mid-week sends no week's summary)
  const hour = Math.floor(now / HOUR) * HOUR
  const due = async (name: string, start: number, grace: number) => {
    if (now < start || now - start > grace) return false
    const { claimRun } = await import('./data/settings')
    return claimRun(env.DB, name, start, now).catch((error) => {
      console.error(`cron: couldn't tell whether ${name} ran`, error)
      return false
    })
  }
  const monday = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - ((at.getUTCDay() + 6) % 7), 7)
  // Settings, Health shows the cron as late when this is over 3 minutes old
  await job('heartbeat', async () => {
    const { CRON_KEY, setSetting } = await import('./data/settings')
    await setSetting(env.DB, CRON_KEY, now, null, now)
  })
  await job('monitors', async () => {
    const { runMonitors } = await import('./monitors/monitors')
    notices.push(...(await runMonitors(env, now, fetch, deadline)))
  })
  // Hourly, from :05: transactions that got slower in a release
  if (await due('slower releases', hour + 5 * MINUTE, 50 * MINUTE))
    await job('slower releases', async () => {
      const { checkSlowerReleases } = await import('./data/performance')
      notices.push(...(await checkSlowerReleases(env.DB, env.PUBLIC_URL ?? '', now)))
    })
  // Mondays from 07:00 UTC: each project's week
  if (await due('weekly summaries', monday, 6 * HOUR))
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
  // Hourly, from :25: issues escalating in the hour just ended
  if (await due('escalation', hour + 25 * MINUTE, 30 * MINUTE))
    await job('escalation', async () => {
      const { checkEscalation } = await import('./data/escalation')
      notices.push(...(await checkEscalation(env.DB, env.PUBLIC_URL ?? '', now, deadline)))
    })
  const { dispatch, flushHeld, pruneFailures } = await import('./notify/dispatch')
  await job('notifications', () => dispatch(env, notices, now))
  await job('held notifications', () => flushHeld(env, now))
  // Hourly, from :15: events, attachments, issues, logs, transactions, check-ins and uptime results past their
  // retention; what's left goes the next hour
  if (await due('retention', hour + 15 * MINUTE, 40 * MINUTE)) {
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
  // Hourly, from :20: sessions and passkey challenges past their end, issues not seen for their project's "Resolve issues
  // not seen for", and notification failures past 30 days
  if (await due('hourly cleanup', hour + 20 * MINUTE, 35 * MINUTE)) {
    await job('sign-in', async () => (await import('./data/people')).pruneSignIn(env.DB, now))
    await job('auto-resolve', async () => (await import('./data/issues')).autoResolve(env.DB, now, deadline))
    await job('notification failures', () => pruneFailures(env.DB, now))
  }
  // Daily from 03:40 UTC, where an owner turned it on: the newest release installed (src/update/install.ts). Never in
  // the demo, which its own workflow deploys
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), 3, 40)
  if (!isDemo(env) && (await due('update', day, 20 * HOUR)))
    await job('update', async () => (await import('./update/install')).autoUpdate(env, now))
  // Last, with what time is left: envelopes that failed in their request, tried again
  await job('retries', async () => (await import('./ingest/retry')).retryPending(env, now, deadline))
}
