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
      new Request(path.startsWith('/') ? `https://x${path}` : `https://x/api/0/organizations/o/${path}`, {
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

  it('finds a project by its slug or its number, a slug of digits first', async () => {
    const { env, all, onlyA, call } = await setup()
    env.DB.sqlite.exec("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (3, '1', 'one', 'k3', 0)")
    const deploy = (token: string, project: string) =>
      call(token, 'POST', 'releases/2.0/deploys/', { environment: 'production', projects: [project] })
    expect((await deploy(all, '2')).status).toBe(201)
    expect((await deploy(all, '1')).status).toBe(201) // the project whose slug is 1, not project 1
    expect((await deploy(onlyA, '2')).status).toBe(403)
    await deploy(all, '99') // no project 99: no deploy
    expect(env.DB.sqlite.prepare('SELECT project_id FROM deploys ORDER BY project_id').all()).toEqual([
      { project_id: 2 },
      { project_id: 3 },
    ])
  })

  it('refuses a token of project a everything on project b', async () => {
    const { env, onlyA, call } = await setup()
    const refused = { detail: 'You do not have permission to perform this action.' }
    const expectRefused = async (response: Response) => {
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(refused)
    }
    await expectRefused(
      await call(onlyA, 'POST', 'artifactbundle/assemble/', { checksum: 'c'.repeat(40), chunks: [], projects: ['b'] }),
    )
    await expectRefused(await call(onlyA, 'POST', 'releases/', { version: '3.0', projects: ['b'] }))
    await expectRefused(await call(onlyA, 'PUT', 'releases/3.0/', { projects: ['b'] }))
    await expectRefused(
      await call(onlyA, 'POST', 'releases/0.9/deploys/', { environment: 'production', projects: ['b'] }),
    )
    // set-commits names no project: project b's 0.9 gets none of them
    await call(onlyA, 'PUT', 'releases/0.9/', {
      commits: [{ id: 'ccc', message: 'Fix', author_name: 'me', timestamp: new Date(NOW).toISOString() }],
    })
    expect(env.DB.sqlite.prepare("SELECT sha FROM release_commits WHERE version = '0.9'").all()).toEqual([
      { sha: 'bbb' },
    ])
    // A deploy naming no project goes to project b's release only through a token that reaches it
    await call(onlyA, 'POST', 'releases/0.9/deploys/', { environment: 'production' })
    expect(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM deploys').get()).toEqual({ n: 0 })
    // The release before 2.0 with commits, project b's 0.9, is never named to project a's token
    expect(await (await call(onlyA, 'GET', 'releases/2.0/previous-with-commits/')).json()).toMatchObject({
      version: '1.0',
    })
    expect(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM releases WHERE version = ?').get('3.0')).toEqual({ n: 0 })
  })

  it('moves a debug file sent again into the new upload, for retention', async () => {
    const { env, all, call } = await setup()
    env.DB.sqlite
      .exec(`INSERT INTO debug_files (project_id, checksum, name, debug_id, arch, kind, file_key, size, created_at)
      VALUES (1, 'c1', 'App', 'd1', 'arm64', 'macho', 'debug-files/1/c1', 1, 5), (1, 'c1', 'App', 'd2', 'x86_64', 'macho', 'debug-files/1/c1', 1, 5),
        (2, 'c1', 'App', 'd1', 'arm64', 'macho', 'debug-files/2/c1', 1, 5)`)
    const answer = await call(all, 'POST', '/api/0/projects/o/a/files/difs/assemble/', {
      c1: { name: 'App', chunks: ['x'] },
    })
    expect(await answer.json()).toMatchObject({ c1: { state: 'ok' } })
    const times = env.DB.sqlite.prepare('SELECT project_id, created_at FROM debug_files ORDER BY project_id').all() as {
      project_id: number
      created_at: number
    }[]
    expect(times.map((t) => [t.project_id, t.created_at > 5])).toEqual([
      [1, true],
      [1, true],
      [2, false],
    ])
  })
})
