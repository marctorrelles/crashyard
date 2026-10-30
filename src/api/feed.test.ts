import { describe, expect, it, vi } from 'vitest'
import { memoryR2, sqliteD1 } from '../../test/fakes'
import { DemoFeed, feed, type FeedInput } from './feed'

// The entrypoint's base class, as the runtime gives it its env and ctx; and ingest without the Wasm module or channels
vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}))
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

function demo(vars: Record<string, string> = { DEMO: '1' }) {
  const db = sqliteD1()
  db.sqlite.exec(
    "INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'brightpan-web', 'Web', 'k1', 0)",
  )
  const files = memoryR2()
  const waits: Promise<unknown>[] = []
  const env = { DB: db, FILES: files, ...vars } as unknown as Env
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as unknown as ExecutionContext
  const send = async (input: Partial<FeedInput>) => {
    const status = await new DemoFeed(ctx, env).send({
      project: 'brightpan-web',
      door: 'envelope',
      body: bytes(''),
      received: Date.now(),
      ...input,
    } as FeedInput)
    await Promise.all(waits)
    return status
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
})
