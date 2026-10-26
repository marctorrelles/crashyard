import { describe, expect, it } from 'vitest'
import { afterResult, check } from './monitors'

const m = (over: Partial<Parameters<typeof afterResult>[0]> = {}) => ({
  status: 'ok' as const,
  failures: 0,
  successes: 3,
  failure_threshold: 2,
  recovery_threshold: 1,
  ...over,
})

describe('monitors', () => {
  it('open an incident at the failure threshold, and close it at the recovery threshold', () => {
    expect(afterResult(m(), false)).toMatchObject({ status: 'ok', failures: 1, change: undefined })
    expect(afterResult(m({ failures: 1 }), false)).toMatchObject({ status: 'failing', failures: 2, change: 'down' })
    expect(afterResult(m({ status: 'failing', failures: 5 }), false)).toMatchObject({
      status: 'failing',
      change: undefined,
    })
    expect(afterResult(m({ status: 'failing', failures: 5, recovery_threshold: 2, successes: 0 }), true)).toMatchObject(
      { status: 'failing', successes: 1 },
    )
    expect(afterResult(m({ status: 'failing', successes: 1, recovery_threshold: 2 }), true)).toMatchObject({
      status: 'ok',
      change: 'up',
    })
    expect(afterResult(m({ status: 'pending', successes: 0 }), true)).toMatchObject({ status: 'ok', change: undefined })
  })

  it('check a URL: its status, what the page says, and how long it takes', async () => {
    const answer = (status: number, body = 'all good') =>
      (async () => new Response(body, { status })) as unknown as typeof fetch
    expect(await check({ url: 'https://x', intervalMinutes: 1 }, answer(200))).toMatchObject({ ok: true, status: 200 })
    expect(await check({ url: 'https://x', intervalMinutes: 1 }, answer(503))).toMatchObject({
      ok: false,
      error: 'returned HTTP 503',
    })
    expect(await check({ url: 'https://x', intervalMinutes: 1, expectedStatus: 401 }, answer(401))).toMatchObject({
      ok: true,
    })
    expect(await check({ url: 'https://x', intervalMinutes: 1, mustContain: 'catalog' }, answer(200))).toMatchObject({
      ok: false,
      error: 'the response didn’t contain “catalog”',
    })
    const never = ((_: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))),
      )) as unknown as typeof fetch
    expect(await check({ url: 'https://x', intervalMinutes: 1, timeoutMs: 20 }, never)).toMatchObject({
      ok: false,
      error: 'timed out',
    })
  })
})
