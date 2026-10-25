// The real thing: the official @sentry/node SDK sending to `vite dev` (the worker, local D1 and R2), and notifications
// reaching a stub ntfy server. Kept under 30 seconds.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import * as Sentry from '@sentry/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPlatformProxy } from 'wrangler'

const STATE = '.wrangler/e2e'
const PORT = 3999
const NTFY_PORT = 3998
const KEY = 'e2e0public0key0000000000000000ab'
const origin = `http://localhost:${PORT}`
const dsn = `http://${KEY}@localhost:${PORT}/1`

let dev: ChildProcess
let ntfy: Server
let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>
const pushes: { title: string; body: string; actions?: string }[] = []

const db = () => proxy.env.DB
const issues = async () =>
  (await db().prepare('SELECT * FROM issues ORDER BY id').all<Record<string, unknown>>()).results
const waitFor = async <T>(probe: () => Promise<T | undefined> | T | undefined, ms = 5000): Promise<T> => {
  const until = Date.now() + ms
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

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
  rmSync(STATE, { recursive: true, force: true })
  execFileSync('pnpm', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', STATE], {
    stdio: 'ignore',
  })
  proxy = await getPlatformProxy<Env>({ persist: { path: `${STATE}/v3` } })
  await db().batch([
    db()
      .prepare(
        "INSERT INTO projects (id, slug, name, platform, public_key, created_at) VALUES (1, 'e2e', 'e2e', 'node', ?, 0)",
      )
      .bind(KEY),
    db()
      .prepare("INSERT INTO channels (id, kind, name, config, created_at) VALUES (1, 'ntfy', 'stub', ?, 0)")
      .bind(JSON.stringify({ server: `http://localhost:${NTFY_PORT}`, topic: 'e2e' })),
    db().prepare(
      `INSERT INTO routes (kinds, thresholds, channel_ids, created_at) VALUES ('["new","threshold","regression"]', '[10]', '[1]', 0)`,
    ),
  ])
  ntfy = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      pushes.push({ title: String(req.headers.title), body, actions: req.headers.actions as string | undefined })
      res.end('{}')
    })
  }).listen(NTFY_PORT)
  dev = spawn('pnpm', ['vite', 'dev', '--port', String(PORT), '--strictPort'], {
    env: { ...process.env, CRASHYARD_STATE: STATE },
    stdio: 'ignore',
  })
  await waitFor(async () => (await fetch(origin).catch(() => null))?.ok, 20_000)
  Sentry.init({ dsn, release: 'e2e@1.0.0', environment: 'production', defaultIntegrations: false })
}, 40_000)

afterAll(async () => {
  await Sentry.close()
  dev?.kill()
  ntfy?.close()
  await proxy?.dispose()
})

describe('ingest, through the real SDK', () => {
  it('makes an issue from an exception, and pushes that it’s new', async () => {
    Sentry.captureException(new Error('the first crash'))
    await Sentry.flush(5000)
    const [issue] = await waitFor(async () => ((await issues()).length ? issues() : undefined))
    expect(issue).toMatchObject({ title: 'Error: the first crash', count: 1, status: 'unresolved', substatus: 'new' })
    const push = await waitFor(() => pushes.find((p) => p.title === 'Error: the first crash'))
    expect(push.body).toContain('new')
    expect(push.actions).toMatch(/Resolve, http:\/\/localhost:3999\/api\/actions\/\d+\/resolve\?expires=/)
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
      pushes.find((p) => p.title === 'TypeError: x is undefined' && p.body.includes('now 10')),
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
    await waitFor(() => pushes.find((p) => p.body.includes('back in app@2')))
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
    // The project cache lasts a minute: a new key on the same project id reads it afresh
    const quotaKey = 'e2e0quota0key00000000000000000cd'
    await db().prepare('UPDATE projects SET public_key = ? WHERE id = 1').bind(quotaKey).run()
    const refused = await send(crash('app@3'), quotaKey)
    expect(refused.status).toBe(429)
    expect(refused.headers.get('x-sentry-rate-limits')).toMatch(/^\d+::organization/)
  })
})
