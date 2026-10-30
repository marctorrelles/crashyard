import { describe, expect, it, vi } from 'vitest'
import { memoryR2, sqliteD1 } from '../../test/fakes'
import { feed, type FeedInput, handleFeed } from './feed'

// Ingest without the Wasm module or channels
vi.mock('../symbols/module', () => ({ sharedSymbolic: () => Promise.reject(new Error('no symbols in tests')) }))
vi.mock('../notify/dispatch', () => ({ dispatch: async () => {} }))

const DAY = 864e5
const bytes = (s: string) => new TextEncoder().encode(s)
const envelope = (...items: [unknown, unknown][]) =>
  bytes(
    [
      JSON.stringify({ sent_at: new Date().toISOString(), dsn: 'https://recorded0key@recorder.local/1' }),
      ...items.flatMap(([h, p]) => [JSON.stringify(h), JSON.stringify(p)]),
    ].join('\n') + '\n',
  )

function demo(vars: Record<string, string> = { DEMO: '1', FEED_SECRET: 'feed-secret' }) {
  const db = sqliteD1()
  db.sqlite.exec(
    "INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'brightpan-web', 'Web', 'k1', 0)",
  )
  const files = memoryR2()
  const waits: Promise<unknown>[] = []
  const env = { DB: db, FILES: files, ...vars } as unknown as Env
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as unknown as ExecutionContext
  const send = async (input: Partial<FeedInput>) => {
    const response = await feed(env, ctx, {
      project: 'brightpan-web',
      door: 'envelope',
      body: bytes(''),
      received: Date.now(),
      ...input,
    } as FeedInput)
    await Promise.all(waits)
    return response.status
  }
  return { db, files, env, ctx, send }
}

describe('the demo’s feed', () => {
  const received = Date.now() - 3 * DAY
  const error = envelope([
    { type: 'event' },
    {
      event_id: 'a'.repeat(32),
      timestamp: received / 1000,
      platform: 'javascript',
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'x is undefined',
            stacktrace: { frames: [{ function: 'RecipeCard', filename: 'app.js', lineno: 1 }] },
          },
        ],
      },
    },
  ])

  it('stores an envelope at the time it says, through ingest', async () => {
    const { db, send } = demo()
    expect(await send({ body: error, received, headers: { 'user-agent': 'Mozilla/5.0', cookie: 'no' } })).toBe(200)
    const issue = db.sqlite.prepare('SELECT first_seen, last_seen FROM issues').get() as Record<string, number>
    expect(issue).toEqual({ first_seen: received, last_seen: received })
    const day = new Date(received).toISOString().slice(0, 10)
    expect(db.sqlite.prepare('SELECT day, events FROM project_days').all()).toEqual([{ day, events: 1 }])
  })

  it('holds no sessions-only envelope in R2', async () => {
    const { files, send } = demo()
    const session = {
      sid: 'b'.repeat(32),
      status: 'ok',
      started: new Date(received).toISOString(),
      attrs: { release: 'web@1' },
    }
    expect(await send({ body: envelope([{ type: 'session' }, session]), received })).toBe(200)
    expect([...files.objects.keys()]).toEqual([])
  })

  it('refuses outside the demo, a time ahead of now and a project that isn’t there', async () => {
    expect(await demo({}).send({ body: error, received })).toBe(403)
    expect(await demo().send({ body: error, received: Date.now() + DAY })).toBe(400)
    expect(await demo().send({ body: error, received, project: 'nope' })).toBe(404)
  })

  it('takes a check-in by the monitor’s slug with the project’s own key', async () => {
    const { db, env, ctx } = demo()
    const body = bytes(
      JSON.stringify({ status: 'ok', monitor_config: { schedule: { type: 'crontab', value: '0 2 * * *' } } }),
    )
    const answer = await feed(env, ctx, {
      project: 'brightpan-web',
      door: 'cron',
      path: ['nightly-price-import', 'recorded0key'],
      headers: { 'content-type': 'application/json' },
      body,
      received: Date.now() - 60_000,
    })
    expect(answer.status).toBe(202)
    expect(db.sqlite.prepare('SELECT slug FROM monitors').all()).toEqual([{ slug: 'nightly-price-import' }])
  })

  it('takes a batch at /__feed with the feeder’s secret, and is not there without it', async () => {
    const { env, ctx } = demo()
    const post = (auth: string | null, body: unknown) =>
      handleFeed(
        new Request('https://crashyard/__feed', {
          method: 'POST',
          headers: auth ? { authorization: auth } : {},
          body: JSON.stringify(body),
        }),
        env,
        ctx,
      )
    const wire = { project: 'nope', door: 'envelope', body: btoa('x'), received: Date.now() }
    expect((await post(null, [wire])).status).toBe(404)
    expect((await post('Bearer wrong', [wire])).status).toBe(404)
    expect((await handleFeed(new Request('https://crashyard/__feed'), env, ctx)).status).toBe(404)
    const answer = await post('Bearer feed-secret', [wire, { ...wire, received: Date.now() + DAY }])
    expect(await answer.json()).toEqual([404, 400])
    expect((await post('Bearer feed-secret', { not: 'a list' })).status).toBe(400)
    const { env: noSecret } = demo({ DEMO: '1' })
    expect((await handleFeed(new Request('https://crashyard/__feed', { method: 'POST' }), noSecret, ctx)).status).toBe(
      404,
    )
  })
})
