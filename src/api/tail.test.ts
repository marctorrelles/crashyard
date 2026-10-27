import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { framesOf, noteWorkers, tailEvent } from './tail'

// A run as the Workers runtime hands it to tail(): only the fields tail.ts reads matter
const run = (outcome: string, extra: Partial<TraceItem> = {}) =>
  ({
    scriptName: 'shop-api',
    outcome,
    eventTimestamp: 1_800_000_000_000,
    event: { request: { url: 'https://shop.example/cart/42?x=1', method: 'POST', headers: { accept: '*/*' } } },
    logs: [{ timestamp: 1_800_000_000_001, level: 'warn', message: ['slow cart', { id: 42 }] }],
    exceptions: [],
    cpuTime: 52,
    wallTime: 900,
    truncated: false,
    ...extra,
  }) as unknown as TraceItem

describe('tailEvent', () => {
  it('makes a run out of CPU time a fatal event grouped by its Worker, with its request and logs', () => {
    const event = tailEvent(run('exceededCpu'), false)
    expect(event).toMatchObject({
      level: 'fatal',
      transaction: 'POST /cart/42',
      request: { method: 'POST', url: 'https://shop.example/cart/42?x=1' },
      exception: { values: [{ type: 'ExceededCpu', value: 'The Worker ran out of CPU time' }] },
      fingerprint: ['cloudflare.tail', 'exceededCpu', 'shop-api'],
      tags: { worker: 'shop-api', 'worker.outcome': 'exceededCpu' },
      contexts: { cloudflare_worker: { cpu_time_ms: 52 } },
      breadcrumbs: { values: [{ level: 'warning', message: 'slow cart {"id":42}' }] },
    })
  })

  it('leaves successes, and exceptions unless the project asked for them', () => {
    const thrown = run('exception', {
      exceptions: [
        { timestamp: 0, name: 'TypeError', message: 'x is undefined', stack: 'TypeError: x\n    at a (index.js:1:2)' },
      ],
    })
    expect(tailEvent(run('ok'), true)).toBeNull()
    expect(tailEvent(run('canceled'), true)).toBeNull()
    expect(tailEvent(thrown, false)).toBeNull()
    expect(tailEvent(thrown, true)).toMatchObject({
      level: 'error',
      fingerprint: undefined,
      exception: { values: [{ type: 'TypeError', stacktrace: { frames: [{ function: 'a', lineno: 1 }] } }] },
    })
  })

  it('names a cron run by its schedule', () => {
    expect(
      tailEvent(run('exceededMemory', { event: { cron: '*/5 * * * *', scheduledTime: 0 } as never }), false),
    ).toMatchObject({
      transaction: 'cron */5 * * * *',
      exception: { values: [{ type: 'ExceededMemory' }] },
    })
  })
})

describe('framesOf', () => {
  it('reads a V8 stack oldest first, with library frames out of the app', () => {
    const stack = [
      'Error: boom',
      '    at charge (index.js:10:5)',
      '    at async fetch (node_modules/hono/dist/hono.js:3:1)',
      '    at index.js:20:3',
    ].join('\n')
    expect(framesOf(stack)).toEqual([
      { function: undefined, filename: 'index.js', lineno: 20, colno: 3, in_app: true },
      { function: 'async fetch', filename: 'node_modules/hono/dist/hono.js', lineno: 3, colno: 1, in_app: false },
      { function: 'charge', filename: 'index.js', lineno: 10, colno: 5, in_app: true },
    ])
  })
})

describe('noteWorkers', () => {
  it('notes each Worker on its first run, then at most once an hour, keeping the others', async () => {
    const db = sqliteD1()
    const seen = () =>
      JSON.parse(
        (db.sqlite.prepare("SELECT value FROM settings WHERE key = 'tail.workers'").get() as { value: string }).value,
      )
    await noteWorkers(db, ['note-a', 'note-a', 'note-b'], 1000)
    await noteWorkers(db, ['note-a', 'note-c'], 2000)
    expect(seen()).toEqual({ 'note-a': 1000, 'note-b': 1000, 'note-c': 2000 })
    await noteWorkers(db, ['note-a'], 1000 + 3_600_000)
    expect(seen()['note-a']).toBe(1000 + 3_600_000)
  })
})
