// D1 and R2 for unit tests, in memory: D1 is node:sqlite with every migration applied, R2 a map with metadata. As much
// of each API as src/ uses, no more.
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

const MIGRATIONS = new URL('../migrations/', import.meta.url)

export function sqliteD1(): D1Database & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:')
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'))
  const result = (sql: string, params: unknown[]) => {
    // D1's own limit, which node:sqlite doesn't have (32,766): a statement binding more fails here as it would there
    if (params.length > 100) throw new Error(`D1 binds 100 values at most, this statement binds ${params.length}`)
    const statement = sqlite.prepare(sql)
    const values = params.map((p) => (p === undefined ? null : p)) as SQLInputValue[]
    if (statement.columns().length) return { results: statement.all(...values), meta: { changes: 0 }, success: true }
    const { changes } = statement.run(...values)
    return { results: [], meta: { changes: Number(changes) }, success: true }
  }
  const statement = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...values: unknown[]) => statement(sql, values),
    all: async () => result(sql, params),
    run: async () => result(sql, params),
    first: async (column?: string) => {
      const row = (result(sql, params).results[0] as Record<string, unknown> | undefined) ?? null
      return column && row ? row[column] : row
    },
  })
  return {
    sqlite,
    prepare: (sql: string) => statement(sql),
    batch: async (statements: ReturnType<typeof statement>[]) => {
      sqlite.exec('BEGIN')
      try {
        const results = statements.map((s) => result(s.sql, s.params))
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database & { sqlite: DatabaseSync }
}

type Stored = { body: Uint8Array; customMetadata: Record<string, string>; uploaded: Date }

export function memoryR2(): R2Bucket & { objects: Map<string, Stored> } {
  const objects = new Map<string, Stored>()
  const bytes = async (value: unknown) =>
    value instanceof Uint8Array
      ? value
      : typeof value === 'string'
        ? new TextEncoder().encode(value)
        : new Uint8Array(await new Response(value as BodyInit).arrayBuffer())
  return {
    objects,
    put: async (key: string, value: unknown, options?: R2PutOptions) => {
      objects.set(key, {
        body: await bytes(value),
        customMetadata: { ...(options?.customMetadata ?? {}) },
        uploaded: new Date(),
      })
      return { key }
    },
    get: async (key: string) => {
      const o = objects.get(key)
      if (!o) return null
      return {
        key,
        customMetadata: o.customMetadata,
        uploaded: o.uploaded,
        arrayBuffer: async () => o.body.slice().buffer,
      }
    },
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key)
    },
    list: async (options?: R2ListOptions) => {
      const keys = [...objects.keys()].filter((k) => k.startsWith(options?.prefix ?? '')).sort()
      // The cursor is the offset of the next page, as text
      const from = Number(options?.cursor ?? 0)
      const page = keys.slice(from, from + (options?.limit ?? 1000))
      const truncated = from + page.length < keys.length
      return {
        objects: page.map((key) => ({ key, customMetadata: objects.get(key)!.customMetadata })),
        truncated,
        cursor: truncated ? String(from + page.length) : undefined,
        delimitedPrefixes: [],
      }
    },
  } as unknown as R2Bucket & { objects: Map<string, Stored> }
}
