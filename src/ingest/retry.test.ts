import { describe, expect, it } from 'vitest'
import { memoryR2, sqliteD1 } from '../../test/fakes'
import {
  type Held,
  hold,
  MAX_ATTEMPTS,
  parseKey,
  parseTodo,
  pendingKey,
  retryPending,
  settle,
  stableEventId,
  type Todo,
} from './retry'

const NOW = Date.UTC(2026, 9, 26, 12)
const body = new TextEncoder().encode('{}\n{"type":"event"}\n{}\n')

async function setup(items?: Todo) {
  const env = { DB: sqliteD1(), FILES: memoryR2() }
  env.DB.sqlite.exec("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'k', 0)")
  const key = pendingKey(1, NOW - 5 * 60_000)
  await hold(env.FILES, key, body, 'envelope', items)
  const held: Held = { ...parseKey(key)!, endpoint: 'envelope' }
  return { env, key, held }
}
const failedOf = (env: Awaited<ReturnType<typeof setup>>['env']) =>
  (
    env.DB.sqlite.prepare('SELECT failed FROM project_days WHERE project_id = 1').get() as
      { failed: number } | undefined
  )?.failed ?? 0

describe('durable ingest', () => {
  it('keeps an envelope whose processing failed under pending/, with what failed', async () => {
    const { env, key, held } = await setup()
    expect(await settle(env, held, body, 1, ['1', '3:2'], NOW)).toBe('pending')
    expect(env.FILES.objects.get(key)?.customMetadata).toEqual({ endpoint: 'envelope', attempts: '1', items: '1,3:2' })
  })

  it('deletes it once a retry succeeds', async () => {
    const { env, key, held } = await setup()
    await settle(env, held, body, 1, ['0'], NOW)
    expect(await retryPending(env, NOW, async () => [])).toEqual({ retried: 1, failed: 0 })
    expect(env.FILES.objects.has(key)).toBe(false)
  })

  it('moves it to failed/ on the fifth failure and counts it on the project’s day', async () => {
    const { env, key, held } = await setup()
    await settle(env, held, body, 1, ['0'], NOW)
    for (let attempt = 2; attempt < MAX_ATTEMPTS; attempt++) {
      expect(await retryPending(env, NOW, async () => ['0'])).toEqual({ retried: 1, failed: 0 })
      expect(env.FILES.objects.get(key)?.customMetadata.attempts).toBe(String(attempt))
    }
    expect(failedOf(env)).toBe(0)
    // A throw counts as everything failing again
    expect(
      await retryPending(env, NOW, async () => {
        throw new Error('down')
      }),
    ).toEqual({ retried: 1, failed: 1 })
    expect(env.FILES.objects.has(key)).toBe(false)
    expect(env.FILES.objects.get(key.replace('pending/', 'failed/'))?.customMetadata).toMatchObject({
      attempts: '5',
      items: '0',
    })
    expect(failedOf(env)).toBe(1)
    expect(await retryPending(env, NOW, async () => [])).toEqual({ retried: 0, failed: 0 })
  })

  it('retries only the items recorded as failed, and leaves an envelope alone for its first two minutes', async () => {
    const { env, held } = await setup(['0', '1', '2'])
    await settle(env, held, body, 1, ['2', '4:3'], NOW)
    const seen: (Todo | undefined)[] = []
    const young = pendingKey(1, NOW - 60_000)
    await hold(env.FILES, young, body, 'store')
    await retryPending(env, NOW, async (h, b, todo) => {
      seen.push(todo)
      expect(h).toMatchObject({ projectId: 1, received: NOW - 5 * 60_000, endpoint: 'envelope' })
      expect(new TextDecoder().decode(b)).toBe(new TextDecoder().decode(body))
      return []
    })
    expect(seen).toEqual([['2', '4:3']])
    expect(env.FILES.objects.has(young)).toBe(true)
    expect([...parseTodo(['2', '4:3', 'x']).entries()]).toEqual([
      [2, 0],
      [4, 3],
    ])
  })

  it('reaches old envelopes past a page of young ones, and retries 50 a minute at most', async () => {
    const env = { DB: sqliteD1(), FILES: memoryR2() }
    // A busy project 1, all in flight, listed first; project 2's old failures after them
    for (let i = 0; i < 1050; i++) await hold(env.FILES, pendingKey(1, NOW - 30_000), body, 'envelope')
    const old = Array.from({ length: 60 }, () => pendingKey(2, NOW - 10 * 60_000))
    for (const key of old) await hold(env.FILES, key, body, 'envelope')
    const seen: number[] = []
    expect(
      await retryPending(env, NOW, async (h) => {
        seen.push(h.projectId)
        return []
      }),
    ).toEqual({ retried: 50, failed: 0 })
    expect(new Set(seen)).toEqual(new Set([2]))
    expect(old.filter((k) => env.FILES.objects.has(k))).toHaveLength(10)
    expect(await retryPending(env, NOW, async () => [])).toEqual({ retried: 10, failed: 0 })
  })

  it('gives an event without an id the same id on every try', async () => {
    const key = pendingKey(1, NOW)
    expect(stableEventId(key, 2)).toMatch(/^[0-9a-f]{32}$/)
    expect(stableEventId(key, 2)).toBe(stableEventId(key, 2))
    expect(stableEventId(key, 3)).not.toBe(stableEventId(key, 2))
  })
})
