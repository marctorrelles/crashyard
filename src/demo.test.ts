import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { sqliteD1 } from '../test/fakes'
import { DEMO_INGEST, DEMO_REFUSAL, demoCacheKey, demoGate, demoRefuses } from './demo'

// The gate reads ingest's doors from src/api/ingest.ts, which loads the Wasm module Node can't
vi.mock('./symbols/module', () => ({ sharedSymbolic: () => Promise.reject(new Error('no symbols in tests')) }))

const SITE = 'https://demo.crashyard.dev'
const env = () => ({ DB: sqliteD1(), DEMO: '1' }) as unknown as Env
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext
const request = (path: string, init: RequestInit = {}) => new Request(`${SITE}${path}`, init)

describe('the demo’s gate', () => {
  it('closes all four ingest doors before reading the body, to browsers too', async () => {
    for (const path of [
      '/api/1/envelope/',
      '/api/1/store/',
      '/api/1/security/?sentry_key=k',
      '/api/1/cron/nightly/k/',
    ]) {
      const answer = (await demoGate(request(path, { method: 'POST', body: 'x' }), env(), ctx))!
      expect(answer.status).toBe(403)
      expect(answer.headers.get('Access-Control-Allow-Origin')).toBe('*')
      expect(await answer.json()).toEqual({ detail: DEMO_INGEST })
    }
  })

  it('closes every way to sign in, set up or join, but Enter demo and Leave demo', async () => {
    for (const path of ['/auth/github/start', '/auth/signin/options', '/auth/recover', '/auth/setup/verify'])
      expect((await demoGate(request(path, { method: 'POST' }), env(), ctx))!.status).toBe(404)
    for (const path of ['/setup', '/invite/abc']) {
      const answer = (await demoGate(request(path), env(), ctx))!
      expect([answer.status, answer.headers.get('Location')]).toEqual([303, `${SITE}/signin`])
    }
  })

  const enter = (next: string, origin = SITE) =>
    demoGate(
      request('/auth/demo', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ next }) }),
      env(),
      ctx,
    )

  it('lets anyone in with a click, back to where they were going on this site only', async () => {
    const answer = (await enter('/issues/4?project=web'))!
    expect(answer.status).toBe(303)
    expect(answer.headers.get('Location')).toBe('/issues/4?project=web')
    expect(answer.headers.get('Set-Cookie')).toBe(
      'crashyard_demo=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure',
    )
    expect((await enter('//evil.example.com'))!.headers.get('Location')).toBe('/')
    expect((await enter('/', 'https://evil.example.com'))!.status).toBe(403)
  })

  it('lets them out again', async () => {
    const answer = (await demoGate(
      request('/auth/signout', { method: 'POST', headers: { Origin: SITE } }),
      env(),
      ctx,
    ))!
    expect(answer.headers.get('Location')).toBe('/signin')
    expect(answer.headers.get('Set-Cookie')).toMatch(/^crashyard_demo=; .*Max-Age=0/)
  })

  const mcp = async (body: unknown, headers: Record<string, string> = {}) =>
    demoGate(
      request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      env(),
      ctx,
    )

  it('answers MCP without a token as the demo’s viewer: reads, and changes refused', async () => {
    const list = (await (await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))!.json()) as {
      result: { tools: { name: string }[] }
    }
    expect(list.result.tools.map((t) => t.name)).toContain('search_issues')
    const call = { name: 'resolve_issue', arguments: { id: 1 } }
    const resolved = (await (await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: call }))!.json()) as {
      result: { isError: boolean; content: { text: string }[] }
    }
    expect(resolved.result).toMatchObject({ isError: true, content: [{ text: DEMO_REFUSAL }] })
    // An agent token goes on to src/server.ts, which checks it
    expect(await mcp({}, { Authorization: 'Bearer cyp_abc' })).toBeNull()
  })

  it('leaves the dashboard, status pages and the upload API to the rest', async () => {
    for (const path of ['/', '/issues', '/status/brightpan', '/api/0/projects/', '/_serverFn/x'])
      expect(await demoGate(request(path), env(), ctx)).toBeNull()
  })

  it('is asked only in the demo', () => {
    expect(readFileSync('src/server.ts', 'utf8')).toMatch(
      /if \(isDemo\(env\)\) \{\n\s*const answer = await demoGate\(request, env, ctx\)/,
    )
    expect(readFileSync('src/server.ts', 'utf8').match(/demoGate\(/g)).toHaveLength(1)
  })

  it('refuses every server function not marked read-only, whatever the role, in the demo only', () => {
    expect(demoRefuses({ DEMO: '1' }, false)).toBe(true)
    expect(demoRefuses({ DEMO: '1' }, true)).toBe(false)
    expect(demoRefuses({}, false)).toBe(false)
    expect(demoRefuses({ DEMO: '0' }, false)).toBe(false)
    // The role is checked after it, so an owner is refused as a viewer is
    expect(readFileSync('src/fns.ts', 'utf8')).toMatch(
      /\.server\(\(\{ next \}\) => \{\n\s*if \(demoRefuses\(env, readOnly\)\) throw new Error\(DEMO_REFUSAL\)\n\s*const r = role\(\)/,
    )
  })
})

describe('the demo’s cache of server functions', () => {
  const key = (cookie: string, path = '/_serverFn/abc?payload=1') =>
    demoCacheKey(new Request(`${SITE}${path}`, { headers: { Cookie: cookie } }))

  it('keeps one answer for the same call and the cookies it reads, whatever else is sent', () => {
    const a = key('theme=dark; tz=Europe/Madrid; crashyard_demo=1')
    expect(key('tz=Europe/Madrid; theme=dark; crashyard_demo=1; _ga=x')).toBe(a)
    expect(key('theme=dark; tz=America/New_York; crashyard_demo=1')).not.toBe(a)
    expect(key('theme=dark; tz=Europe/Madrid; crashyard_project=web')).not.toBe(a)
    expect(key('theme=dark; tz=Europe/Madrid', '/_serverFn/abc?payload=2')).not.toBe(a)
  })
})
