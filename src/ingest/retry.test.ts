import { describe, expect, it } from 'vitest'
import { memoryR2, sqliteD1 } from '../../test/fakes'
import {
  type Held,
  hold,
  HOLD_IN_D1_MAX,
  MAX_ATTEMPTS,
  parseTodo,
  pendingKey,
  release,
  retryPending,
  settle,
  stableEventId,
  type Store,
  type Todo,
} from './retry'

const NOW = Date.UTC(2026, 9, 26, 12)
/** The cron's shared deadline, far enough off */
const soon = () => Date.now() + 20_000
const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array) => [...bytes].join(',')
/** Text, held in D1 */
const text = encode('﻿{}\n{"type":"event"}\n{"message":"café ☕"}\n')
/** Binary (a NUL in an attachment), held in R2 */
const binary = encode('{}\n{"type":"attachment","length":3}\n\0\x01\xff\n')
const bodies: Record<Store, Uint8Array> = { d1: text, r2: binary }

type Env = { DB: ReturnType<typeof sqliteD1>; FILES: ReturnType<typeof memoryR2> }

function emptyEnv(): Env {
  const env = { DB: sqliteD1(), FILES: memoryR2() }
  env.DB.sqlite.exec(
    "INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'k', 0), (2, 'b', 'b', 'l', 0)",
  )
  return env
}

/** The held copy's state, wherever it is: attempts, items and lease as R2's metadata spells them */
function stateOf(env: Env, key: string): Record<string, string> | undefined {
  const row = env.DB.sqlite
    .prepare('SELECT endpoint, attempts, items, leased_until FROM held_envelopes WHERE key = ?')
    .get(key) as { endpoint: string; attempts: number; items: string | null; leased_until: number | null } | undefined
  if (row)
    return {
      endpoint: row.endpoint,
      attempts: String(row.attempts),
      ...(row.items !== null ? { items: row.items } : {}),
      ...(row.leased_until !== null ? { leased_until: String(row.leased_until) } : {}),
    }
  return env.FILES.objects.get(key)?.customMetadata
}
const heldCount = (env: Env) =>
  (env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM held_envelopes').get() as { n: number }).n +
  [...env.FILES.objects.keys()].filter((k) => k.startsWith('pending/')).length
const failedOf = (env: Env) =>
  (
    env.DB.sqlite.prepare('SELECT failed FROM project_days WHERE project_id = 1').get() as
      { failed: number } | undefined
  )?.failed ?? 0

describe.each(['d1', 'r2'] as const)('durable ingest, held in %s', (store) => {
  const body = bodies[store]
  async function setup(items?: Todo) {
    const env = emptyEnv()
    const key = pendingKey(1, NOW - 5 * 60_000)
    const held = (await hold(env, key, body, 'envelope', items))!
    expect(held.store).toBe(store)
    return { env, key, held }
  }

  it('keeps an envelope whose processing failed, with what failed', async () => {
    const { env, key, held } = await setup()
    expect(await settle(env, held, body, 1, ['1', '3:2'], NOW)).toBe('pending')
    expect(stateOf(env, key)).toEqual({ endpoint: 'envelope', attempts: '1', items: '1,3:2' })
  })

  it('deletes it once a retry succeeds, the body as it came', async () => {
    const { env, key, held } = await setup()
    await settle(env, held, body, 1, ['0'], NOW)
    const seen: Uint8Array[] = []
    expect(
      await retryPending(env, NOW, soon(), async (_, b) => {
        seen.push(b)
        return []
      }),
    ).toEqual({ retried: 1, failed: 0 })
    expect(seen.map(decode)).toEqual([decode(body)])
    expect(stateOf(env, key)).toBeUndefined()
    expect(heldCount(env)).toBe(0)
  })

  it('moves it to failed/ on the fifth failure and counts it on the project’s day', async () => {
    const { env, key, held } = await setup()
    await settle(env, held, body, 1, ['0'], NOW)
    for (let attempt = 2; attempt < MAX_ATTEMPTS; attempt++) {
      expect(await retryPending(env, NOW, soon(), async () => ['0'])).toEqual({ retried: 1, failed: 0 })
      expect(stateOf(env, key)?.attempts).toBe(String(attempt))
    }
    expect(failedOf(env)).toBe(0)
    // A throw counts as everything failing again
    expect(
      await retryPending(env, NOW, soon(), async () => {
        throw new Error('down')
      }),
    ).toEqual({ retried: 1, failed: 1 })
    expect(stateOf(env, key)).toBeUndefined()
    const failed = env.FILES.objects.get(key.replace('pending/', 'failed/'))
    expect(failed?.customMetadata).toMatchObject({ attempts: '5', items: '0' })
    expect(decode(failed!.body)).toBe(decode(body))
    expect(failedOf(env)).toBe(1)
    expect(await retryPending(env, NOW, soon(), async () => [])).toEqual({ retried: 0, failed: 0 })
  })

  it('retries only the items recorded as failed, and leaves an envelope alone for its first two minutes', async () => {
    const { env, held } = await setup(['0', '1', '2'])
    await settle(env, held, body, 1, ['2', '4:3'], NOW)
    const seen: (Todo | undefined)[] = []
    const young = pendingKey(1, NOW - 60_000)
    await hold(env, young, body, 'store')
    await retryPending(env, NOW, soon(), async (h, b, todo) => {
      seen.push(todo)
      expect(h).toEqual({ ...held, received: NOW - 5 * 60_000, endpoint: 'envelope', store })
      expect(decode(b)).toBe(decode(body))
      return []
    })
    expect(seen).toEqual([['2', '4:3']])
    expect(stateOf(env, young)).toEqual({ endpoint: 'store', attempts: '1' })
  })

  it('counts a try before it starts, so an envelope that stops its worker still ends in failed/', async () => {
    const { env, key } = await setup()
    expect(stateOf(env, key)?.attempts).toBe('1')
    // Each run's pass never settles, as when the envelope stops the worker: the run is left hanging
    const stopped = () => new Promise<never>(() => {})
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
    for (let run = 1; run <= 5; run++) {
      void retryPending(env, NOW + run * 2 * 60_000, soon(), stopped)
      await tick()
    }
    expect(stateOf(env, key)).toBeUndefined()
    expect(env.FILES.objects.get(key.replace('pending/', 'failed/'))?.customMetadata.attempts).toBe('5')
    expect(failedOf(env)).toBe(1)
  })

  it('leases an envelope while it is tried, so an overlapping run leaves it alone', async () => {
    const { env, key } = await setup()
    let calls = 0
    const slow = () => {
      calls++
      return new Promise<never>(() => {})
    }
    void retryPending(env, NOW, soon(), slow)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(stateOf(env, key)).toMatchObject({ attempts: '2', leased_until: String(NOW + 90_000) })
    expect(await retryPending(env, NOW + 60_000, soon(), slow)).toEqual({ retried: 0, failed: 0 })
    expect(calls).toBe(1)
  })

  it('leaves what it can’t reach before the deadline untried', async () => {
    const { env, key } = await setup()
    expect(await retryPending(env, NOW, Date.now(), async () => [])).toEqual({ retried: 0, failed: 0 })
    expect(stateOf(env, key)?.attempts).toBe('1')
  })

  it('drops the held copy when the envelope turns out not to be one', async () => {
    const { env, held } = await setup()
    await release(env, held)
    expect(heldCount(env)).toBe(0)
  })
})

describe('where an envelope is held', () => {
  it('holds UTF-8 text up to HOLD_IN_D1_MAX in D1, without writing to R2', async () => {
    const env = emptyEnv()
    const key = pendingKey(1, NOW)
    expect(await hold(env, key, text, 'envelope', ['1'])).toEqual({
      key,
      projectId: 1,
      received: NOW,
      endpoint: 'envelope',
      store: 'd1',
    })
    expect(env.FILES.objects.size).toBe(0)
    expect(stateOf(env, key)).toEqual({ endpoint: 'envelope', attempts: '1', items: '1' })
    const largest = encode('x'.repeat(HOLD_IN_D1_MAX))
    expect((await hold(env, pendingKey(1, NOW), largest, 'envelope'))?.store).toBe('d1')
  })

  it('holds a larger body, binary or not valid UTF-8 in R2', async () => {
    const env = emptyEnv()
    for (const body of [encode('x'.repeat(HOLD_IN_D1_MAX + 1)), binary, new Uint8Array([0x7b, 0xc3, 0x28, 0x7d])]) {
      const key = pendingKey(1, NOW)
      expect((await hold(env, key, body, 'envelope'))?.store).toBe('r2')
      expect(decode(env.FILES.objects.get(key)!.body)).toBe(decode(body))
    }
    expect(heldCount(env)).toBe(3)
  })

  it('falls back to R2 when D1 refuses, and holds nothing when neither takes it', async () => {
    const env = emptyEnv()
    const down = {
      ...env,
      DB: { prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error('D1 down')) }) }) },
    }
    const key = pendingKey(1, NOW)
    expect((await hold(down as unknown as Env, key, text, 'envelope'))?.store).toBe('r2')
    expect(env.FILES.objects.get(key)?.customMetadata).toEqual({ endpoint: 'envelope', attempts: '1' })
    // A project deleted meanwhile fails D1's foreign key, and R2 takes it
    expect((await hold(env, pendingKey(9, NOW), text, 'envelope'))?.store).toBe('r2')
    const neither = { ...down, FILES: { put: () => Promise.reject(new Error('R2 down')) } }
    expect(await hold(neither as unknown as Env, pendingKey(1, NOW), text, 'envelope')).toBeUndefined()
  })
})

describe('the cron', () => {
  it('drains D1 and R2, envelopes R2 held before 0038 among them', async () => {
    const env = emptyEnv()
    const inD1 = (await hold(env, pendingKey(1, NOW - 5 * 60_000), text, 'envelope'))!
    const inR2 = (await hold(env, pendingKey(2, NOW - 5 * 60_000), binary, 'store'))!
    // As a worker from before wrote it: text in R2, with its metadata only
    const before = pendingKey(1, NOW - 60 * 60_000)
    await env.FILES.put(before, text, { customMetadata: { endpoint: 'envelope', attempts: '2', items: '0' } })
    const seen: [string, Store, Todo | undefined][] = []
    expect(
      await retryPending(env, NOW, soon(), async (h, _, todo) => {
        seen.push([h.key, h.store, todo])
        return []
      }),
    ).toEqual({ retried: 3, failed: 0 })
    expect(seen).toEqual([
      [inD1.key, 'd1', undefined],
      [before, 'r2', ['0']],
      [inR2.key, 'r2', undefined],
    ])
    expect(heldCount(env)).toBe(0)
  })

  it('retries 25 a minute at most across both stores', async () => {
    const env = emptyEnv()
    for (let i = 0; i < 20; i++) await hold(env, pendingKey(1, NOW - 10 * 60_000), text, 'envelope')
    for (let i = 0; i < 20; i++) await hold(env, pendingKey(2, NOW - 10 * 60_000), binary, 'envelope')
    const seen: Store[] = []
    const pass = async (h: Held) => {
      seen.push(h.store)
      return []
    }
    expect(await retryPending(env, NOW, soon(), pass)).toEqual({ retried: 25, failed: 0 })
    expect(seen.filter((s) => s === 'd1')).toHaveLength(20)
    expect(await retryPending(env, NOW, soon(), pass)).toEqual({ retried: 15, failed: 0 })
    expect(heldCount(env)).toBe(0)
  })

  it('reaches old R2 envelopes past a page of young ones', async () => {
    const env = emptyEnv()
    // A busy project 1, all in flight, listed first; project 2's old failures after them
    for (let i = 0; i < 1050; i++) await hold(env, pendingKey(1, NOW - 30_000), binary, 'envelope')
    const old = Array.from({ length: 30 }, () => pendingKey(2, NOW - 10 * 60_000))
    for (const key of old) await hold(env, key, binary, 'envelope')
    const seen: number[] = []
    expect(
      await retryPending(env, NOW, soon(), async (h) => {
        seen.push(h.projectId)
        return []
      }),
    ).toEqual({ retried: 25, failed: 0 })
    expect(new Set(seen)).toEqual(new Set([2]))
    expect(old.filter((k) => env.FILES.objects.has(k))).toHaveLength(5)
  })
})

describe('items and ids', () => {
  it('reads the items to do', () => {
    expect([...parseTodo(['2', '4:3', 'x']).entries()]).toEqual([
      [2, 0],
      [4, 3],
    ])
  })

  it('gives an event without an id the same id on every try', async () => {
    const key = pendingKey(1, NOW)
    expect(stableEventId(key, 2)).toMatch(/^[0-9a-f]{32}$/)
    expect(stableEventId(key, 2)).toBe(stableEventId(key, 2))
    expect(stableEventId(key, 3)).not.toBe(stableEventId(key, 2))
  })
})
