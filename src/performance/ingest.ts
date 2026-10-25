// Transactions and sessions as the SDKs send them, summarised rather than kept: a transaction adds to its hour's
// count and histogram (2 rows), and becomes an example only if it's among the day's ten slowest for its name.
import { dayOf } from '../ingest/store'
import { bucketOf } from './histogram'

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
const secs = (v: unknown) => (typeof v === 'number' ? v * 1000 : typeof v === 'string' ? Date.parse(v) : NaN)

const HOUR = 3_600_000
const EXAMPLES = 10
const MAX_SPANS = 200

export type Span = { op: string; description: string; start: number; duration: number; status?: string; depth: number }

export function summarize(raw: Json, received: number) {
  const start = secs(raw.start_timestamp)
  const end = secs(raw.timestamp)
  const trace = obj(obj(raw.contexts).trace)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  const name = (str(raw.transaction) ?? '<unnamed>').slice(0, 200)
  // Spans under the root, as offsets from the start, with their depth for a waterfall
  const rootId = str(trace.span_id)
  const spans = (Array.isArray(raw.spans) ? raw.spans : []).map(obj)
  const parents = new Map(spans.map((s) => [str(s.span_id), str(s.parent_span_id)]))
  const depthOf = (id: string | undefined, n = 0): number =>
    !id || id === rootId || n > 20 ? n : depthOf(parents.get(id), n + 1)
  const list: Span[] = spans
    .map((s) => ({
      op: str(s.op) ?? 'span',
      description: (str(s.description) ?? '').slice(0, 300),
      start: Math.round(secs(s.start_timestamp) - start),
      duration: Math.round(secs(s.timestamp) - secs(s.start_timestamp)),
      status: str(s.status),
      depth: depthOf(str(s.parent_span_id)),
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.duration))
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_SPANS)
  const status = str(trace.status)
  return {
    id: str(raw.event_id)?.replace(/-/g, '') ?? crypto.randomUUID().replace(/-/g, ''),
    name,
    release: str(raw.release) ?? '',
    environment: str(raw.environment),
    op: str(trace.op),
    status,
    error: !!status && status !== 'ok',
    traceId: str(trace.trace_id),
    timestamp: Math.round(end) || received,
    duration: Math.round(end - start),
    spans: list,
  }
}

export type Summary = NonNullable<ReturnType<typeof summarize>>

/**
 * Streamed spans (an envelope's `span` item, `application/vnd.sentry.items.span.v2+json`: what the JavaScript SDKs send
 * since v11, instead of transactions) as transactions: one per segment span in the item, with its children from the
 * same item.
 * ponytail: children flushed in an earlier envelope than their segment miss its waterfall; buffer by segment id if that shows.
 */
export function fromSpans(raw: Json): Json[] {
  const items = (Array.isArray(raw.items) ? raw.items : []).map(obj)
  const attr = (s: Json, key: string) => obj(obj(s.attributes)[key]).value
  const segmentOf = (s: Json) => str(attr(s, 'sentry.segment.id')) ?? str(s.span_id)
  return items
    .filter((s) => s.is_segment === true)
    .map((root) => ({
      event_id: `${str(root.trace_id)?.slice(0, 16) ?? ''}${str(root.span_id) ?? ''}`,
      transaction: str(attr(root, 'sentry.segment.name')) ?? root.name,
      start_timestamp: root.start_timestamp,
      timestamp: root.end_timestamp,
      release: attr(root, 'sentry.release'),
      environment: attr(root, 'sentry.environment'),
      contexts: {
        trace: { span_id: root.span_id, trace_id: root.trace_id, op: attr(root, 'sentry.op'), status: root.status },
      },
      spans: items
        .filter((s) => s !== root && segmentOf(s) === str(root.span_id))
        .map((s) => ({ ...s, op: attr(s, 'sentry.op'), description: s.name, timestamp: s.end_timestamp })),
    }))
}

export async function storeTransaction(db: D1Database, projectId: number, t: Summary, received: number) {
  const hour = Math.floor(received / HOUR) * HOUR
  const day = dayOf(t.timestamp)
  const statements = [
    db
      .prepare(
        `INSERT INTO transaction_hours (project_id, name, release, hour, count, errors, sum_ms) VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT DO UPDATE SET count = count + 1, errors = errors + excluded.errors, sum_ms = sum_ms + excluded.sum_ms`,
      )
      .bind(projectId, t.name, t.release, hour, t.error ? 1 : 0, t.duration),
    db
      .prepare(
        `INSERT INTO transaction_buckets (project_id, name, release, hour, bucket, count) VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT DO UPDATE SET count = count + 1`,
      )
      .bind(projectId, t.name, t.release, hour, bucketOf(t.duration)),
    db
      .prepare(
        'INSERT INTO project_days (project_id, day, transactions) VALUES (?, ?, 1) ON CONFLICT DO UPDATE SET transactions = transactions + 1',
      )
      .bind(projectId, dayOf(received)),
  ]
  // An example only if it's among the day's slowest for its name
  const slowest = await db
    .prepare(
      'SELECT COUNT(*) AS n, MIN(duration) AS fastest FROM (SELECT duration FROM transaction_examples WHERE project_id = ? AND name = ? AND day = ? ORDER BY duration DESC LIMIT ?)',
    )
    .bind(projectId, t.name, day, EXAMPLES)
    .first<{ n: number; fastest: number | null }>()
  if (!slowest || slowest.n < EXAMPLES || t.duration > (slowest.fastest ?? 0)) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO transaction_examples (id, project_id, name, release, environment, day, timestamp, duration, status, trace_id, spans)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          t.id,
          projectId,
          t.name,
          t.release,
          t.environment ?? null,
          day,
          t.timestamp,
          t.duration,
          t.status ?? null,
          t.traceId ?? null,
          JSON.stringify(t.spans),
        ),
      db
        .prepare(
          `DELETE FROM transaction_examples WHERE id IN (SELECT id FROM transaction_examples WHERE project_id = ? AND name = ? AND day = ?
           ORDER BY duration DESC LIMIT -1 OFFSET ?)`,
        )
        .bind(projectId, t.name, day, EXAMPLES),
    )
  }
  await db.batch(statements)
}

type SessionCounts = { started: number; errored: number; abnormal: number; crashed: number }

/** A `session` item (one session's update) or a `sessions` item (aggregates), as counts per release and day */
export function sessionCounts(type: 'session' | 'sessions', raw: Json, received: number) {
  const attrs = obj(raw.attrs)
  const key = { release: str(attrs.release) ?? '', environment: str(attrs.environment) ?? 'production' }
  const out: (typeof key & { day: string } & SessionCounts)[] = []
  if (type === 'session') {
    // The browser SDK (11.9) says `unhandled` where the others say `crashed`
    const status = str(raw.status) === 'unhandled' ? 'crashed' : str(raw.status)
    const ended = status === 'exited' || status === 'crashed' || status === 'abnormal'
    out.push({
      ...key,
      day: dayOf(Number.isFinite(secs(raw.started)) ? secs(raw.started) : received),
      started: raw.init === true ? 1 : 0,
      crashed: status === 'crashed' ? 1 : 0,
      abnormal: status === 'abnormal' ? 1 : 0,
      errored: ended && status === 'exited' && Number(raw.errors) > 0 ? 1 : 0,
    })
  } else {
    for (const a of (Array.isArray(raw.aggregates) ? raw.aggregates : []).map(obj)) {
      const n = (k: string) => (typeof a[k] === 'number' ? (a[k] as number) : 0)
      out.push({
        ...key,
        day: dayOf(Number.isFinite(secs(a.started)) ? secs(a.started) : received),
        started: n('exited') + n('errored') + n('abnormal') + n('crashed'),
        errored: n('errored'),
        abnormal: n('abnormal'),
        crashed: n('crashed'),
      })
    }
  }
  return out.filter((c) => c.started || c.errored || c.abnormal || c.crashed)
}

export async function storeSessions(db: D1Database, projectId: number, counts: ReturnType<typeof sessionCounts>) {
  if (!counts.length) return
  await db.batch(
    counts.map((c) =>
      db
        .prepare(
          `INSERT INTO sessions_daily (project_id, release, environment, day, started, errored, abnormal, crashed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO UPDATE SET started = started + excluded.started, errored = errored + excluded.errored,
             abnormal = abnormal + excluded.abnormal, crashed = crashed + excluded.crashed`,
        )
        .bind(projectId, c.release, c.environment, c.day, c.started, c.errored, c.abnormal, c.crashed),
    ),
  )
}
