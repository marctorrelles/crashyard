// Sentry's structured logs (https://develop.sentry.dev/sdk/telemetry/logs/): a `log` item holds `{ items: [...] }`,
// each with a timestamp (seconds), level, body, trace id and typed attributes ({ value, type }).
import { scrub, scrubText } from './scrub'
import { timestampOf } from './event'

export type Log = {
  timestamp: number // ms
  level: string
  body: string
  attributes: Record<string, string | number | boolean>
  release?: string
  environment?: string
  traceId?: string
}

const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
const ALIASES: Record<string, string> = { warning: 'warn', critical: 'fatal', log: 'info' }
const MAX_BODY = 8192
const MAX_ATTRIBUTES = 64
/** Attributes indexed for search and facets, per log: the app's own, not the SDK's `sentry.*` */
export const INDEXED_ATTRIBUTES = 16

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})

const valueOf = (v: unknown): string | number | boolean | undefined => {
  const typed = obj(v)
  const raw = 'value' in typed ? typed.value : v
  if (typeof raw === 'string') return raw.slice(0, 1024)
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'boolean') return raw
  return undefined
}

export function normalizeLogs(payload: unknown, received: number): Log[] {
  const items = obj(payload).items
  if (!Array.isArray(items)) return []
  return items.slice(0, 1000).map((raw) => {
    const item = obj(raw)
    const attributes: Log['attributes'] = {}
    for (const [key, value] of Object.entries(obj(item.attributes)).slice(0, MAX_ATTRIBUTES)) {
      // The SDK adds the scope's user (id, email, name) to every log: not kept, as events keep only a hash
      if (key.startsWith('user.')) continue
      const v = valueOf(value)
      if (v !== undefined) attributes[key] = v
    }
    const scrubbed = scrub(attributes) as Log['attributes']
    const level = String(item.level ?? 'info').toLowerCase()
    const str = (k: string) => (typeof scrubbed[k] === 'string' ? (scrubbed[k] as string) : undefined)
    return {
      timestamp: timestampOf(item.timestamp) ?? received,
      level: LEVELS.has(level) ? level : (ALIASES[level] ?? 'info'),
      body: scrubText(String(item.body ?? '')).slice(0, MAX_BODY),
      attributes: scrubbed,
      release: str('sentry.release'),
      environment: str('sentry.environment'),
      traceId: typeof item.trace_id === 'string' && /^[0-9a-f]{32}$/.test(item.trace_id) ? item.trace_id : undefined,
    }
  })
}

/** Writes logs and their indexed attributes, in one batch (about 2 + attributes rows each) */
export async function storeLogs(db: D1Database, projectId: number, logs: Log[], received: number, day: string) {
  if (!logs.length) return
  const statements: D1PreparedStatement[] = []
  for (const log of logs) {
    statements.push(
      db
        .prepare(
          `INSERT INTO logs (project_id, timestamp, received, level, body, attributes, release, environment, trace_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          projectId,
          log.timestamp,
          received,
          log.level,
          log.body,
          JSON.stringify(log.attributes),
          log.release ?? null,
          log.environment ?? null,
          log.traceId ?? null,
        ),
    )
    const own = Object.entries(log.attributes)
      .filter(([k]) => !k.startsWith('sentry.'))
      .slice(0, INDEXED_ATTRIBUTES)
    // log_attributes is WITHOUT ROWID, so last_insert_rowid() stays the log's through these
    for (const [key, value] of own) {
      statements.push(
        db
          .prepare('INSERT INTO log_attributes (log_id, project_id, key, value) VALUES (last_insert_rowid(), ?, ?, ?)')
          .bind(projectId, key, String(value)),
      )
    }
  }
  statements.push(
    db
      .prepare(
        'INSERT INTO project_days (project_id, day, logs) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET logs = logs + excluded.logs',
      )
      .bind(projectId, day, logs.length),
  )
  await db.batch(statements)
}
