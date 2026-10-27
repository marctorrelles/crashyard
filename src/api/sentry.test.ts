import { describe, expect, it } from 'vitest'
import { memoryR2, sqliteD1 } from '../../test/fakes'
import { createToken } from '../data/tokens'
import { handleSentryApi } from './sentry'

const NOW = Date.UTC(2026, 9, 26, 12)

async function setup() {
  const env = { DB: sqliteD1(), FILES: memoryR2() }
  env.DB.sqlite.exec(`
    INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'ka', 0), (2, 'b', 'b', 'kb', 0);
    INSERT INTO releases (project_id, version, ref, created_at) VALUES (1, '1.0', 'aaa', 1), (2, '0.9', 'bbb', 2),
      (1, '2.0', NULL, 3), (2, '2.0', NULL, 3);
    INSERT INTO release_commits (project_id, version, position, sha, message) VALUES
      (1, '1.0', 0, 'aaa', 'Start'), (2, '0.9', 0, 'bbb', 'Begin');
  `)
  const all = await createToken(env.DB, 'all', 'me', NOW)
  const onlyA = await createToken(env.DB, 'a', 'me', NOW, 1)
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const waits: Promise<unknown>[] = []
    const response = await handleSentryApi(
      new Request(`https://x/api/0/organizations/o/${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      {
        env,
        ctx: { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as unknown as ExecutionContext,
        symbolic: () => Promise.reject(new Error('no symbols in tests')),
        reprocess: async () => {},
      },
    )
    await Promise.all(waits)
    return response
  }
  return { env, all, onlyA, call }
}

describe('the Sentry API', () => {
  it('stores a deploy’s link only when it’s http or https', async () => {
    const { env, all, call } = await setup()
    const deploy = (url: string) => call(all, 'POST', 'releases/2.0/deploys/', { environment: 'production', url })
    expect((await deploy('javascript:alert(1)')).status).toBe(201)
    expect((await deploy('https://example.org/run/1')).status).toBe(201)
    expect(env.DB.sqlite.prepare('SELECT DISTINCT url FROM deploys ORDER BY url').all()).toEqual([
      { url: null },
      { url: 'https://example.org/run/1' },
    ])
  })

  it('finds the release before with commits only in a scoped token’s project', async () => {
    const { all, onlyA, call } = await setup()
    const previous = async (token: string) =>
      (await (await call(token, 'GET', 'releases/2.0/previous-with-commits/')).json()) as { version: string }
    // Both projects have 2.0: project b's 0.9 is newer, but a token of project a never sees it
    expect((await previous(all)).version).toBe('0.9')
    expect((await previous(onlyA)).version).toBe('1.0')
  })
})
