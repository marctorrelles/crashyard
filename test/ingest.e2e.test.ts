// The real thing: the official @sentry/node SDK sending to `vite dev` (the worker, local D1 and R2), and notifications
// reaching a stub Telegram Bot API. Kept under 30 seconds.
import { createServer, type Server } from 'node:http'
import * as Sentry from '@sentry/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mergeIssues } from '../src/data/issues'
import { saveMonitor } from '../src/data/monitors'
import { checkSlowerReleases, transaction, transactions } from '../src/data/performance'
import { releaseHealth } from '../src/data/releases'
import { bucketOf } from '../src/performance/histogram'
import { KEY, startDev, waitFor } from './dev'

const PORT = 3999
const STUB_PORT = 3998
const origin = `http://localhost:${PORT}`
const dsn = `http://${KEY}@localhost:${PORT}/1`

let dev: Awaited<ReturnType<typeof startDev>>
let stub: Server
const pushes: { title: string; body: string }[] = []

const db = () => dev.db
const issues = async () =>
  (await db().prepare('SELECT * FROM issues ORDER BY id').all<Record<string, unknown>>()).results

function envelope(event: Record<string, unknown>) {
  return `${JSON.stringify({ event_id: event.event_id, dsn })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`
}
const send = (event: Record<string, unknown>, key = KEY) =>
  fetch(`${origin}/api/1/envelope/`, {
    method: 'POST',
    headers: { 'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${key}` },
    body: envelope(event),
  })
const id = () => crypto.randomUUID().replace(/-/g, '')
const crash = (release: string) => ({
  event_id: id(),
  release,
  platform: 'javascript',
  exception: {
    values: [
      {
        type: 'TypeError',
        value: 'x is undefined',
        stacktrace: { frames: [{ function: 'render', filename: 'app.js', in_app: true }] },
      },
    ],
  },
})

beforeAll(async () => {
  stub = createServer((req, res) => {
    // Also what the uptime checks ask: /health answers, /down doesn't
    if (req.url === '/health') return void res.end('catalog ok')
    if (req.url === '/down') return void ((res.statusCode = 503), res.end())
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      // A bot's message: the title in bold, then the line under it
      const [title, line] = (JSON.parse(body) as { text: string }).text.split('\n')
      pushes.push({ title: title.replace(/<\/?b>/g, ''), body: line })
      res.end('{}')
    })
  }).listen(STUB_PORT)
  dev = await startDev(PORT, '.wrangler/e2e')
  await db().batch([
    db()
      .prepare("INSERT INTO channels (id, kind, name, config, created_at) VALUES (1, 'telegram', 'stub', ?, 0)")
      .bind(JSON.stringify({ server: `http://localhost:${STUB_PORT}`, token: 'e2e', chat: '1' })),
    db().prepare(
      `INSERT INTO routes (kinds, thresholds, channel_ids, created_at) VALUES ('["new","threshold","regression","monitor_down","monitor_up","weekly"]', '[10]', '[1]', 0)`,
    ),
  ])
  Sentry.init({ dsn, release: 'e2e@1.0.0', environment: 'production', defaultIntegrations: false, tracesSampleRate: 1 })
}, 60_000)

afterAll(async () => {
  await Sentry.close()
  stub?.close()
  await dev?.stop()
})

describe('ingest, through the real SDK', () => {
  it('makes an issue from an exception, and pushes that it’s new', async () => {
    Sentry.captureException(new Error('the first crash'))
    await Sentry.flush(5000)
    const [issue] = await waitFor(async () => ((await issues()).length ? issues() : undefined))
    expect(issue).toMatchObject({ title: 'Error: the first crash', count: 1, status: 'unresolved', substatus: 'new' })
    const push = await waitFor(() => pushes.find((p) => p.title === 'Error: the first crash'))
    expect(push.body).toContain('New issue')
  })

  it('adds the same error to the same issue, and keeps a message apart', async () => {
    const again = () => {
      try {
        throw new Error('repeat me')
      } catch (e) {
        Sentry.captureException(e)
      }
    }
    for (let i = 0; i < 2; i++) again() // one place: called from two lines, they'd be two stacks, so two issues
    Sentry.captureMessage('something odd', 'warning')
    await Sentry.flush(5000)
    const all = await waitFor(async () => {
      const rows = await issues()
      return rows.length >= 3 ? rows : undefined
    })
    expect(all.find((i) => i.title === 'Error: repeat me')).toMatchObject({ count: 2 })
    expect(all.find((i) => i.title === 'something odd')).toMatchObject({ count: 1, level: 'warning', type: 'message' })
    const tags = await db().prepare("SELECT key, value FROM event_tags WHERE key IN ('release', 'environment')").all()
    expect(tags.results).toContainEqual({ key: 'release', value: 'e2e@1.0.0' })
  })

  it('pushes when an issue reaches a route’s threshold', async () => {
    for (let i = 0; i < 10; i++) expect((await send(crash('app@1'))).status).toBe(200)
    const push = await waitFor(() =>
      pushes.find((p) => p.title === 'TypeError: x is undefined' && p.body.includes('Reached 10 events')),
    )
    expect(push).toBeTruthy()
  })

  it('reopens a resolved issue as a regression, and only for another release', async () => {
    const issue = (await issues()).find((i) => i.title === 'TypeError: x is undefined')!
    await db()
      .prepare("UPDATE issues SET status = 'resolved', resolved_in_release = 'app@1' WHERE id = ?")
      .bind(issue.id)
      .run()
    await send(crash('app@1'))
    expect((await db().prepare('SELECT status FROM issues WHERE id = ?').bind(issue.id).first())?.status).toBe(
      'resolved',
    )
    await send(crash('app@2'))
    expect(await db().prepare('SELECT status, substatus FROM issues WHERE id = ?').bind(issue.id).first()).toEqual({
      status: 'unresolved',
      substatus: 'regressed',
    })
    await waitFor(() => pushes.find((p) => p.body.includes('Regressed in app@2')))
  })

  it('keeps an event sent twice once, refuses a wrong key, and answers 429 past the quota', async () => {
    const event = crash('app@3')
    await send(event)
    await send(event)
    expect((await db().prepare('SELECT COUNT(*) AS n FROM events WHERE id = ?').bind(event.event_id).first())?.n).toBe(
      1,
    )
    expect((await send(crash('app@3'), 'wrongkey000000000000000000000000')).status).toBe(403)
    await db().prepare('UPDATE projects SET daily_event_quota = 1 WHERE id = 1').run()
    // The project cache lasts a minute: a second key of the same project reads it afresh
    const quotaKey = 'e2e0quota0key00000000000000000cd'
    await db()
      .prepare("INSERT INTO project_keys (project_id, public_key, label, created_at) VALUES (1, ?, 'Quota', 0)")
      .bind(quotaKey)
      .run()
    const refused = await send(crash('app@3'), quotaKey)
    expect(refused.status).toBe(429)
    expect(refused.headers.get('x-sentry-rate-limits')).toMatch(/^\d+:error;[a-z;]+:organization:usage_exceeded$/)
  })

  it('sends a merged issue’s events to the issue it went into', async () => {
    const other = (type: string) => ({
      ...crash('app@4'),
      exception: {
        values: [{ type, value: 'x', stacktrace: { frames: [{ function: type, filename: 'm.js', in_app: true }] } }],
      },
    })
    await db().prepare('UPDATE projects SET daily_event_quota = 10000 WHERE id = 1').run()
    await send(other('MergeA'))
    await send(other('MergeB'))
    const find = async (t: string) => (await issues()).find((i) => i.title === `${t}: x`)
    const [a, b] = [await find('MergeA'), await find('MergeB')]
    await mergeIssues(db(), [a!.id as number, b!.id as number], 'test', Date.now())
    expect(await find('MergeB')).toBeUndefined()
    expect((await find('MergeA'))?.count).toBe(2)
    await send(other('MergeB'))
    expect((await find('MergeA'))?.count).toBe(3)
    expect(await find('MergeB')).toBeUndefined()
  })

  it('keeps the SDK’s logs with their attributes, and drops the user', async () => {
    Sentry.setUser({ id: 'u1', email: 'someone@example.com' })
    Sentry.logger.info('song opened', { song: 42, mode: 'live' })
    Sentry.logger.warn('export slow')
    await Sentry.flush(5000)
    const log = await waitFor(() =>
      db().prepare("SELECT * FROM logs WHERE body = 'song opened'").first<Record<string, unknown>>(),
    ).then((row) => row!)
    expect(log).toMatchObject({ level: 'info', release: 'e2e@1.0.0', environment: 'production' })
    const attributes = JSON.parse(String(log.attributes))
    expect(attributes).toMatchObject({ song: 42, mode: 'live' })
    expect(Object.keys(attributes).filter((k) => k.startsWith('user.'))).toEqual([])
    const indexed = await db()
      .prepare('SELECT key, value FROM log_attributes WHERE log_id = ? ORDER BY key')
      .bind(log.id)
      .all()
    expect(indexed.results).toEqual(
      expect.arrayContaining([
        { key: 'mode', value: 'live' },
        { key: 'song', value: '42' },
      ]),
    )
    Sentry.setUser(null)
  })

  it('keeps an event’s trace id, to find its logs', async () => {
    const rows = await db()
      .prepare('SELECT COUNT(*) AS n FROM events WHERE trace_id IS NOT NULL')
      .first<{ n: number }>()
    expect(rows!.n).toBeGreaterThan(0)
  })

  it('answers MCP: tools, an issue search and an issue with its stack', async () => {
    type Result = { serverInfo: { name: string }; tools: { name: string }[]; content: { text: string }[] }
    const rpc = async (method: string, params?: unknown) => {
      const response = await fetch(`${origin}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      return ((await response.json()) as { result: Result }).result
    }
    expect((await rpc('initialize', { protocolVersion: '2025-06-18' })).serverInfo.name).toBe('crashyard')
    const tools = (await rpc('tools/list')).tools.map((t) => t.name)
    expect(tools).toContain('get_issue')
    const found = (await rpc('tools/call', { name: 'search_issues', arguments: { query: 'repeat' } })).content[0].text
    const id = Number(found.match(/^#(\d+)/)![1])
    const issue = (await rpc('tools/call', { name: 'get_issue', arguments: { id } })).content[0].text
    expect(issue).toContain('# Error: repeat me')
    expect(issue).toMatch(/\* again at .*ingest\.e2e\.test\.ts/)
    const page = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })
    expect(page.status).toBe(403)
  })

  it('makes a cron monitor from a check-in, and tells when a run fails, comes back, or never comes', async () => {
    const monitorConfig = {
      schedule: { type: 'crontab' as const, value: '0 3 * * *' },
      checkinMargin: 5,
      maxRuntime: 10,
    }
    const id = Sentry.captureCheckIn({ monitorSlug: 'nightly', status: 'in_progress' }, monitorConfig)
    await Sentry.flush(5000) // as a job would: its run between the two
    Sentry.captureCheckIn({ checkInId: id, monitorSlug: 'nightly', status: 'error', duration: 2 })
    await Sentry.flush(5000)
    const monitor = await waitFor(() =>
      db()
        .prepare("SELECT * FROM monitors WHERE slug = 'nightly' AND status = 'failing'")
        .first<Record<string, number>>(),
    )
    expect(await waitFor(() => pushes.find((p) => p.title === 'nightly failed'))).toBeTruthy()
    Sentry.captureCheckIn({ monitorSlug: 'nightly', status: 'ok' }, monitorConfig)
    await Sentry.flush(5000)
    await waitFor(() => pushes.find((p) => p.title === 'nightly recovered'))
    // Nothing by the next 03:00 and its five minutes: missed
    const due = (await db()
      .prepare('SELECT next_due FROM monitors WHERE id = ?')
      .bind(monitor.id)
      .first<{ next_due: number }>())!.next_due
    await fetch(`${origin}/__dev/cron?now=${due + 1000}`, { method: 'POST' })
    expect(
      await db()
        .prepare("SELECT COUNT(*) AS n FROM check_ins WHERE monitor_id = ? AND status = 'missed'")
        .bind(monitor.id)
        .first(),
    ).toEqual({ n: 1 })
    await waitFor(() => pushes.find((p) => p.title === 'nightly missed its check-in'))
  })

  it('takes check-ins over HTTP as Sentry’s crons endpoint does: GET or POST, a config making the monitor', async () => {
    const url = `${origin}/api/1/cron/backup/${KEY}/`
    // A POST with monitor_config, as Sentry's docs show it, makes the monitor
    const config = { schedule: { type: 'crontab', value: '0 * * * *' }, checkin_margin: 5, max_runtime: 30 }
    const made = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monitor_config: config, status: 'ok', environment: 'staging' }),
    })
    expect([made.status, await made.text()]).toEqual([202, ''])
    const monitor = await waitFor(() =>
      db().prepare("SELECT * FROM monitors WHERE slug = 'backup'").first<{ id: number; status: string }>(),
    )
    expect(monitor.status).toBe('ok')
    // Then curl's GETs: in progress, then ok without an id finishes that same run
    expect((await fetch(`${url}?status=in_progress`)).status).toBe(202)
    expect((await fetch(`${url}?status=ok&environment=staging`)).status).toBe(202)
    const runs = await db()
      .prepare(
        'SELECT status, environment, finished IS NOT NULL AS done FROM check_ins WHERE monitor_id = ? ORDER BY started',
      )
      .bind(monitor.id)
      .all()
    expect(runs.results).toEqual([
      { status: 'ok', environment: 'staging', done: 1 },
      { status: 'ok', environment: 'staging', done: 1 },
    ])
    // A status is needed, and the key must be the project's
    expect((await fetch(`${url}?status=maybe`)).status).toBe(400)
    expect((await fetch(`${origin}/api/1/cron/backup/nope/?status=ok`)).status).toBe(403)
  })

  it('turns a CSP report, either shape, into an issue titled by what was blocked', async () => {
    const post = (type: string, body: unknown) =>
      fetch(`${origin}/api/1/security/?sentry_key=${KEY}&sentry_environment=production`, {
        method: 'POST',
        headers: { 'content-type': type, 'user-agent': 'Mozilla/5.0 Firefox/130.0' },
        body: JSON.stringify(body),
      })
    const old = await post('application/csp-report', {
      'csp-report': {
        'document-uri': 'https://app.example.com/songs',
        'violated-directive': 'script-src-elem',
        'effective-directive': 'script-src-elem',
        'blocked-uri': 'https://evil.example.net/x.js',
        disposition: 'enforce',
      },
    })
    expect([old.status, await old.text()]).toEqual([200, ''])
    const next = await post('application/reports+json', [
      {
        type: 'csp-violation',
        url: 'https://app.example.com/other',
        body: {
          effectiveDirective: 'script-src-elem',
          blockedURL: 'https://evil.example.net/y.js',
          disposition: 'enforce',
        },
      },
    ])
    expect(next.status).toBe(200)
    const issue = await waitFor(() =>
      db()
        .prepare("SELECT title, culprit, type, count FROM issues WHERE type = 'csp' AND count = 2")
        .first<Record<string, unknown>>(),
    )
    expect(issue).toEqual({
      title: "Blocked 'script' from 'evil.example.net'",
      culprit: 'script-src-elem',
      type: 'csp',
      count: 2,
    })
    expect((await post('text/plain', {})).status).toBe(415)
  })

  it('turns a watched Worker’s run out of CPU time into an issue, and leaves the rest', async () => {
    await db().prepare(`UPDATE projects SET workers = '["shop-api"]' WHERE id = 1`).run()
    const run = (scriptName: string, outcome: string) => ({
      scriptName,
      outcome,
      eventTimestamp: Date.now(),
      event: { request: { url: 'https://shop.example/cart', method: 'POST', headers: {} } },
      logs: [{ timestamp: Date.now(), level: 'log', message: ['pricing cart'] }],
      exceptions: [{ timestamp: Date.now(), name: 'TypeError', message: 'cart is null' }],
      cpuTime: 51,
      wallTime: 300,
      truncated: false,
    })
    const tail = await fetch(`${origin}/__dev/tail`, {
      method: 'POST',
      // An exception the SDK sends itself, a success, and a Worker no project watches: none of them an issue
      body: JSON.stringify([
        run('shop-api', 'exceededCpu'),
        run('shop-api', 'exception'),
        run('shop-api', 'ok'),
        run('other-api', 'exceededCpu'),
      ]),
    })
    expect(tail.status).toBe(200)
    const found = await waitFor(() =>
      db()
        .prepare(
          "SELECT title, level, count FROM issues WHERE title LIKE 'ExceededCpu%' OR title LIKE 'TypeError: cart%'",
        )
        .all<Record<string, unknown>>()
        .then((r) => (r.results.length ? r.results : null)),
    )
    expect(found).toEqual([{ title: 'ExceededCpu: The Worker ran out of CPU time', level: 'fatal', count: 1 }])
    // Every Worker that sent a run is noted, watched or not, for Connect an app to list
    const seen = await waitFor(() =>
      db().prepare("SELECT value FROM settings WHERE key = 'tail.workers'").first<{ value: string }>(),
    )
    expect(Object.keys(JSON.parse(seen.value)).sort()).toEqual(['other-api', 'shop-api'])
  })

  it('checks a URL, and opens an incident after two failures in a row', async () => {
    const config = { url: `http://localhost:${STUB_PORT}/health`, intervalMinutes: 1, mustContain: 'catalog' }
    const base = {
      project_id: 1,
      name: 'Sync server',
      environment: 'production',
      failure_threshold: 2,
      recovery_threshold: 1,
    }
    const id = await saveMonitor(db(), { ...base, kind: 'uptime', config }, Date.now())
    const now = Date.now()
    await fetch(`${origin}/__dev/cron?now=${now}`, { method: 'POST' })
    expect(await db().prepare('SELECT status FROM monitors WHERE id = ?').bind(id).first()).toEqual({ status: 'ok' })
    await saveMonitor(
      db(),
      { ...base, id, kind: 'uptime', config: { ...config, url: `http://localhost:${STUB_PORT}/down` } },
      now,
    )
    await fetch(`${origin}/__dev/cron?now=${now + 1000}`, { method: 'POST' })
    expect(pushes.find((p) => p.title === 'Sync server is down')).toBeUndefined()
    await fetch(`${origin}/__dev/cron?now=${now + 61_000}`, { method: 'POST' })
    const push = await waitFor(() => pushes.find((p) => p.title === 'Sync server is down'))
    expect(push.body).toContain('returned HTTP 503')
    expect(
      await db()
        .prepare('SELECT COUNT(*) AS n FROM incidents WHERE monitor_id = ? AND closed_at IS NULL')
        .bind(id)
        .first(),
    ).toEqual({ n: 1 })
  })

  it('sums up each project’s week on Monday morning', async () => {
    // Monday 7 January 2030, 07:00 UTC: the week is 31 December to 6 January
    const monday = Date.UTC(2030, 0, 7, 7)
    const issue = (await db()
      .prepare('SELECT id, title FROM issues ORDER BY id LIMIT 1')
      .first<{ id: number; title: string }>())!
    await db().batch([
      db().prepare(
        "INSERT INTO project_days (project_id, day, events) VALUES (1, '2030-01-02', 30), (1, '2029-12-26', 20)",
      ),
      db().prepare("INSERT INTO issue_days (issue_id, day, count) VALUES (?, '2030-01-03', 30)").bind(issue.id),
      db().prepare(
        "INSERT INTO sessions_daily (project_id, release, environment, day, started, crashed) VALUES (1, 'e2e@9', 'production', '2030-01-04', 200, 3)",
      ),
    ])
    await fetch(`${origin}/__dev/cron?now=${monday - 60_000}`, { method: 'POST' })
    expect(pushes.find((p) => p.title.includes('last week'))).toBeUndefined()
    await fetch(`${origin}/__dev/cron?now=${monday}`, { method: 'POST' })
    const push = await waitFor(() => pushes.find((p) => p.title.includes('last week')))
    expect(push.title).toBe('30 events last week, up 50% on the week before')
    expect(push.body).toBe(
      `e2e · 0 new issues · Top issue: ${issue.title}, 30 events · 98.5% crash-free sessions in e2e@9`,
    )
  })

  it('summarises transactions: percentiles by name, the slowest kept with their spans', async () => {
    await Sentry.startSpan({ name: 'GET /songs', op: 'http.server' }, () =>
      Sentry.startSpan({ name: 'SELECT songs', op: 'db' }, () => new Promise((r) => setTimeout(r, 30))),
    )
    await Sentry.flush()
    const t = await waitFor(async () =>
      (await transactions(db(), 1, 1, Date.now())).transactions.find((x) => x.name === 'GET /songs'),
    )
    expect(t.count).toBe(1)
    expect(t.p95).toBeGreaterThanOrEqual(30)
    const detail = await transaction(db(), 1, 'GET /songs', 1, Date.now())
    expect(detail.examples[0].spans).toMatchObject([{ op: 'db', description: 'SELECT songs', depth: 0 }])
  })

  it('counts sessions, one by one and in aggregates, for crash-free rates', async () => {
    const attrs = { release: 'e2e@2.0.0', environment: 'production' }
    const started = new Date().toISOString()
    const items = [
      [{ type: 'session' }, { sid: id(), did: 'ada', init: true, started, status: 'crashed', errors: 1, attrs }],
      [{ type: 'sessions' }, { aggregates: [{ started, exited: 3 }], attrs }],
    ]
    const body = [JSON.stringify({ dsn }), ...items.flat().map((x) => JSON.stringify(x))].join('\n')
    const response = await fetch(`${origin}/api/1/envelope/`, {
      method: 'POST',
      headers: { 'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${KEY}` },
      body,
    })
    expect(response.status).toBe(200)
    expect((await releaseHealth(db(), 1, Date.now())).get('e2e@2.0.0')).toMatchObject({
      sessions: 4,
      crashed: 1,
      users: 1,
      crashFreeUsers: 0,
    })
  })

  it('tells once when a release makes a transaction slower', async () => {
    // A month ahead, so the transactions sent above are out of the two weeks it compares
    const now = Date.now() + 30 * 864e5
    const hour = (h: number) => Math.floor((now - h * 3_600_000) / 3_600_000) * 3_600_000
    const seed = (release: string, at: number, ms: number) => [
      db()
        .prepare(
          "INSERT INTO transaction_hours (project_id, name, release, hour, count) VALUES (1, 'GET /slow', ?, ?, 60)",
        )
        .bind(release, at),
      db()
        .prepare(
          "INSERT INTO transaction_buckets (project_id, name, release, hour, bucket, count) VALUES (1, 'GET /slow', ?, ?, ?, 60)",
        )
        .bind(release, at, bucketOf(ms)),
    ]
    await db().batch([...seed('e2e@3.0.0', hour(5), 100), ...seed('e2e@3.1.0', hour(1), 400)])
    const [notice] = await checkSlowerReleases(db(), origin, now)
    expect(notice.issue.title).toBe('GET /slow is slower in e2e@3.1.0')
    expect(await checkSlowerReleases(db(), origin, now)).toEqual([])
  })

  it('serves attachments behind sign-in: images inline, anything else as a download, none able to run', async () => {
    const event = crash('e2e@1.0.0')
    const item = (filename: string, type: string, body: string) =>
      `${JSON.stringify({ type: 'attachment', length: body.length, filename, content_type: type })}\n${body}\n`
    const response = await fetch(`${origin}/api/1/envelope/`, {
      method: 'POST',
      headers: { 'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${KEY}` },
      body:
        envelope(event) +
        item('shot.png', 'image/png', 'not really a png') +
        item('page.html', 'text/html', '<script>alert(1)</script>'),
    })
    expect(response.status).toBe(200)
    const rows = await waitFor(async () => {
      const r = await db()
        .prepare('SELECT id, filename FROM attachments WHERE event_id = ? ORDER BY id')
        .bind(event.event_id)
        .all<{ id: number; filename: string }>()
      return r.results.length === 2 ? r.results : undefined
    })
    const [png, html] = await Promise.all(rows.map((r) => fetch(`${origin}/attachments/${r.id}`)))
    expect(png.headers.get('content-type')).toBe('image/png')
    expect(png.headers.get('content-disposition')).toBe('inline; filename="shot.png"')
    expect(html.headers.get('content-type')).toBe('application/octet-stream')
    expect(html.headers.get('content-disposition')).toBe('attachment; filename="page.html"')
    for (const r of [png, html]) {
      expect(r.headers.get('x-content-type-options')).toBe('nosniff')
      expect(r.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    }
    expect(await html.text()).toBe('<script>alert(1)</script>')
    expect((await fetch(`${origin}/attachments/999999`)).status).toBe(404)
  })

  it('answers 200 when storing fails, and stores the event once when the cron tries it again', async () => {
    await db().batch([
      db()
        .prepare("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (2, 'flaky', 'flaky', ?, 0)")
        .bind('e2e0flaky0key00000000000000000ab'),
      // D1 refusing the event's write, as an outage would
      db().prepare(
        "CREATE TRIGGER e2e_fail BEFORE INSERT ON events WHEN NEW.project_id = 2 BEGIN SELECT RAISE(ABORT, 'forced'); END",
      ),
    ])
    const event = { ...crash('flaky@1'), exception: { values: [{ type: 'FlakyError', value: 'stored later' }] } }
    const response = await fetch(`${origin}/api/2/envelope/`, {
      method: 'POST',
      headers: { 'x-sentry-auth': 'Sentry sentry_version=7, sentry_key=e2e0flaky0key00000000000000000ab' },
      body: envelope(event),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: event.event_id })
    const stored = () => db().prepare('SELECT COUNT(*) AS n FROM events WHERE id = ?').bind(event.event_id).first()
    expect(await stored()).toEqual({ n: 0 })
    await db().prepare('DROP TRIGGER e2e_fail').run()
    // Too young for the cron at first, then tried again, then nothing left to try
    await fetch(`${origin}/__dev/cron?now=${Date.now()}`, { method: 'POST' })
    expect(await stored()).toEqual({ n: 0 })
    for (const minutes of [3, 4])
      await fetch(`${origin}/__dev/cron?now=${Date.now() + minutes * 60_000}`, { method: 'POST' })
    expect(await stored()).toEqual({ n: 1 })
    expect(
      await db()
        .prepare("SELECT count, substatus FROM issues WHERE project_id = 2 AND title LIKE 'FlakyError%'")
        .first(),
    ).toEqual({ count: 1, substatus: 'new' })
    expect(await waitFor(() => pushes.find((p) => p.title === 'FlakyError: stored later'))).toBeTruthy()
  })
})
