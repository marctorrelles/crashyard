// Transactions and sessions as the SDKs send them, summarised rather than kept: a transaction adds to its hour's
// count and histogram (2 rows), and becomes an example only if it's among the day's ten slowest for its name.
import { dayOf } from '../ingest/store'
import { bucketOf } from './histogram'
import { vitalsOf } from './vitals'

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
  const rows = spans
    .map((s) => ({
      id: str(s.span_id),
      parent: str(s.parent_span_id),
      at: secs(s.start_timestamp),
      span: {
        op: str(s.op) ?? 'span',
        description: (str(s.description) ?? '').slice(0, 300),
        start: Math.round(secs(s.start_timestamp) - start),
        duration: Math.round(secs(s.timestamp) - secs(s.start_timestamp)),
        status: str(s.status),
        depth: depthOf(str(s.parent_span_id)),
      } as Span,
    }))
    .filter((r) => Number.isFinite(r.span.start) && Number.isFinite(r.span.duration))
    // By the start as sent, finer than the millisecond kept, so spans a few microseconds apart keep their order
    .sort((a, b) => a.at - b.at)
  // In tree order, siblings by start: a child stays under its parent when both started in the same millisecond
  const ids = new Set(rows.map((r) => r.id))
  const children = Map.groupBy(rows, (r) => (r.parent && ids.has(r.parent) ? r.parent : undefined))
  const ordered: typeof rows = []
  const seen = new Set<(typeof rows)[number]>()
  const walk = (parent: string | undefined) => {
    for (const r of children.get(parent) ?? []) {
      if (seen.has(r)) continue
      seen.add(r)
      ordered.push(r)
      if (r.id) walk(r.id)
    }
  }
  walk(undefined)
  // Spans in a cycle of parents have no way down from the root: kept, after the rest
  const list = [...ordered, ...rows.filter((r) => !seen.has(r))].map((r) => r.span).slice(0, MAX_SPANS)
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
    vitals: vitalsOf(raw.measurements),
  }
}

export type Summary = NonNullable<ReturnType<typeof summarize>>

/**
 * Streamed spans (an envelope's `span` item, `application/vnd.sentry.items.span.v2+json`: what the JavaScript SDKs send
 * since v11, and sentry-dart since 10, instead of transactions) as transactions: one per segment span in the item,
 * with its children from the same item and those that came before it (`earlier`, from `pending_spans`).
 */
export function fromSpans(raw: Json, earlier: Json[] = []): Json[] {
  const items = (Array.isArray(raw.items) ? raw.items : []).map(obj)
  // A span sent twice, held and again, counts once
  const all = [...new Map([...earlier, ...items].map((s, i) => [str(s.span_id) ?? i, s])).values()]
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
      spans: all
        .filter((s) => s !== root && segmentOf(s) === str(root.span_id))
        .map((s) => ({ ...s, op: attr(s, 'sentry.op'), description: s.name, timestamp: s.end_timestamp })),
    }))
}

const attr = (s: Json, key: string) => obj(obj(s.attributes)[key]).value
const segmentOf = (s: Json) => str(attr(s, 'sentry.segment.id')) ?? str(s.span_id)

/**
 * A `span` item's transactions. An SDK sends spans as they finish, a batch every few seconds, so a segment longer
 * than that comes after its children: they're held in `pending_spans` until it does. `release` drops the held spans
 * its segments read, once their transactions are stored, so a retry before that reads them again.
 * ponytail: a child that ends after its segment stays held until pruned; Sentry shows it apart too.
 */
export async function spanTransactions(db: D1Database, projectId: number, raw: Json, received: number) {
  const items = (Array.isArray(raw.items) ? raw.items : []).map(obj)
  const roots = new Set(items.filter((s) => s.is_segment === true).map((s) => str(s.span_id)))
  const segments = JSON.stringify([...roots])
  const waiting = items
    .filter((s) => s.is_segment !== true && str(s.span_id) && !roots.has(segmentOf(s)))
    .map((s) => [str(s.span_id), segmentOf(s), JSON.stringify(s)])
  if (waiting.length)
    await db
      .prepare(
        `INSERT OR IGNORE INTO pending_spans (project_id, span_id, segment_id, received, span)
         SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), ?, json_extract(value, '$[2]') FROM json_each(?)`,
      )
      .bind(projectId, received, JSON.stringify(waiting))
      .run()
  const held =
    roots.size === 0
      ? []
      : (
          await db
            .prepare(
              'SELECT span FROM pending_spans WHERE project_id = ? AND segment_id IN (SELECT value FROM json_each(?))',
            )
            .bind(projectId, segments)
            .all<{ span: string }>()
        ).results.map((r) => obj(JSON.parse(r.span)))
  return {
    transactions: fromSpans(raw, held),
    release: async () => {
      if (held.length)
        await db
          .prepare('DELETE FROM pending_spans WHERE project_id = ? AND segment_id IN (SELECT value FROM json_each(?))')
          .bind(projectId, segments)
          .run()
    },
  }
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
    // Each vital the SDK measured, into its histogram: a browser page load adds about five rows, an app start one or two
    ...t.vitals.map((v) =>
      db
        .prepare(
          `INSERT INTO vital_buckets (project_id, name, release, hour, vital, bucket, count) VALUES (?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT DO UPDATE SET count = count + 1`,
        )
        .bind(projectId, t.name, t.release, hour, v.vital, bucketOf(v.stored)),
    ),
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

type SessionCounts = {
  started: number
  errored: number
  abnormal: number
  crashed: number
  did?: string
  sid?: string
}

// The session's distinct id as the SDK sends it (`did`, often the user id): only ever stored as a salted hash
const didOf = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined)

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
      did: didOf(raw.did),
      sid: str(raw.sid)?.slice(0, 64),
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
        did: didOf(a.did),
      })
    }
  }
  // A session update that changes no count still says its user was there
  return out.filter((c) => c.started || c.errored || c.abnormal || c.crashed || c.did)
}

/** A session's `did` as stored: SHA-256 of it salted with the project, so the same id in two projects differs */
export async function didHash(projectId: number, did: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`session:${projectId}:${did}`))
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
}

export async function storeSessions(
  db: D1Database,
  projectId: number,
  received: ReturnType<typeof sessionCounts>,
  now = Date.now(),
) {
  if (!received.length) return
  // A crash counts once a session: the browser SDK sends an `unhandled` session again (once the page is idle, or the
  // user changes), as Relay counts it once by session id
  const counts = []
  for (const c of received) {
    const first =
      !c.crashed ||
      !c.sid ||
      (await db
        .prepare(
          'INSERT INTO session_crashes (project_id, sid, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING sid',
        )
        .bind(projectId, c.sid, now)
        .first())
    counts.push(first ? c : { ...c, crashed: 0 })
  }
  const statements = counts
    .filter((c) => c.started || c.errored || c.abnormal || c.crashed)
    .map((c) =>
      db
        .prepare(
          `INSERT INTO sessions_daily (project_id, release, environment, day, started, errored, abnormal, crashed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO UPDATE SET started = started + excluded.started, errored = errored + excluded.errored,
             abnormal = abnormal + excluded.abnormal, crashed = crashed + excluded.crashed`,
        )
        .bind(projectId, c.release, c.environment, c.day, c.started, c.errored, c.abnormal, c.crashed),
    )
  // One row per user, release, environment and day: an upsert, so a retried envelope counts no one twice
  for (const c of counts)
    if (c.did)
      statements.push(
        db
          .prepare(
            `INSERT INTO session_users_daily (project_id, release, environment, day, did_hash, crashed) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT DO UPDATE SET crashed = MAX(crashed, excluded.crashed)`,
          )
          .bind(projectId, c.release, c.environment, c.day, await didHash(projectId, c.did), c.crashed ? 1 : 0),
      )
  if (statements.length) await db.batch(statements)
}
