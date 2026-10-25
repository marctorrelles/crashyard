// A dev server (`vite dev`: the worker with local D1 and R2) on its own port and state, wiped each run, with a
// project to send to. Tests reach its database through it (`/__dev/sql`, dev only), never by opening the file too.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { rmSync } from 'node:fs'

export const KEY = 'e2e0public0key0000000000000000ab'

export const waitFor = async <T>(
  probe: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  ms = 10_000,
): Promise<T> => {
  const until = Date.now() + ms
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

type Result = { results: unknown[]; meta: Record<string, unknown>; success: boolean }

/** As much of D1's API as the tests and src/data use, over HTTP to the dev server */
function remoteD1(origin: string): D1Database {
  const run = async (statements: { sql: string; params: unknown[] }[]) => {
    const response = await fetch(`${origin}/__dev/sql`, { method: 'POST', body: JSON.stringify(statements) })
    if (!response.ok) throw new Error(`D1 over HTTP: ${response.status} ${await response.text()}`)
    return (await response.json()) as Result[]
  }
  const statement = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...values: unknown[]) => statement(sql, values),
    all: async () => (await run([{ sql, params }]))[0],
    run: async () => (await run([{ sql, params }]))[0],
    first: async () => ((await run([{ sql, params }]))[0].results[0] as unknown) ?? null,
    raw: async () => {
      throw new Error('raw() is not in the test shim')
    },
  })
  return {
    prepare: (sql: string) => statement(sql),
    batch: (statements: ReturnType<typeof statement>[]) =>
      run(statements.map((s) => ({ sql: s.sql, params: s.params }))),
  } as unknown as D1Database
}

export async function startDev(port: number, state: string) {
  rmSync(state, { recursive: true, force: true })
  execFileSync('pnpm', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state], {
    stdio: 'ignore',
  })
  const dev: ChildProcess = spawn('pnpm', ['vite', 'dev', '--port', String(port), '--strictPort'], {
    env: { ...process.env, CRASHYARD_STATE: state },
    stdio: 'ignore',
  })
  const origin = `http://localhost:${port}`
  await waitFor(async () => (await fetch(origin).catch(() => null))?.ok, 30_000)
  const db = remoteD1(origin)
  await db
    .prepare(
      "INSERT INTO projects (id, slug, name, platform, public_key, created_at) VALUES (1, 'e2e', 'e2e', 'node', ?, 0)",
    )
    .bind(KEY)
    .run()
  return { origin, dsn: `http://${KEY}@localhost:${port}/1`, db, stop: async () => void dev.kill() }
}
