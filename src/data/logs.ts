// Logs: the explorer's page of logs (newest first, searched, within a time range), the facets over what matched,
// what's newer than the newest shown (the live tail), and how many there were per bucket of time, by level.
import { logFilter } from '../search/query'
import { buckets, fill, intervalFor, SIZE } from './charts'

export const PAGE_LOGS = 100
export const RANGES = { '1h': 36e5, '24h': 864e5, '7d': 6048e5, '30d': 2592e6 } as const
export type Range = keyof typeof RANGES
// The longest exact span a page can ask for (a drag on the chart, ?from=&to=)
export const MAX_SPAN = 90 * 864e5

/** The time a page looks at: a preset up to now, or an exact span, `from` included and `to` not (a drag-zoom) */
export type Window = { range: Range } | { from: number; to: number }

/** A window as its span; a preset's ends now */
export const spanOf = (w: Window, now: number) => ('range' in w ? { from: now - RANGES[w.range], to: now } : w)

type Search = { query: string; projectId?: number; window: Window }

/** A search's conditions over `logs l`, narrowed to a project and to the slugs of its `project:` tokens */
function conditions(opts: Omit<Search, 'window'>, now: number) {
  const f = logFilter(opts.query, now)
  const where = [...f.where]
  const params = [...f.params]
  if (opts.projectId) {
    where.push('l.project_id = ?')
    params.push(opts.projectId)
  }
  if (f.projectSlugs.length) {
    where.push(`l.project_id IN (SELECT id FROM projects WHERE slug IN (${f.projectSlugs.map(() => '?').join(',')}))`)
    params.push(...f.projectSlugs)
  }
  return { where, params }
}

export type LogRow = {
  id: number
  project: string
  timestamp: number
  level: string
  body: string
  attributes: string // JSON
  release: string | null
  environment: string | null
  trace_id: string | null
}

type Cursor = { timestamp: number; id: number }

export async function listLogs(db: D1Database, opts: Search & { before?: Cursor; after?: Cursor }, now: number) {
  const { where, params } = conditions(opts, now)
  // A preset reads on past now (the live tail, a clock that's ahead); an exact span stops at its end
  const span = spanOf(opts.window, now)
  where.push('l.timestamp >= ?')
  params.push(span.from)
  if (!('range' in opts.window)) {
    where.push('l.timestamp < ?')
    params.push(span.to)
  }
  const base = [...where]
  const baseParams = [...params]
  if (opts.before) {
    where.push('(l.timestamp < ? OR (l.timestamp = ? AND l.id < ?))')
    params.push(opts.before.timestamp, opts.before.timestamp, opts.before.id)
  }
  if (opts.after) {
    where.push('(l.timestamp > ? OR (l.timestamp = ? AND l.id > ?))')
    params.push(opts.after.timestamp, opts.after.timestamp, opts.after.id)
  }
  const rows = (
    await db
      .prepare(
        `SELECT l.id, p.slug AS project, l.timestamp, l.level, l.body, l.attributes, l.release, l.environment, l.trace_id
         FROM logs l JOIN projects p ON p.id = l.project_id WHERE ${where.join(' AND ')}
         ORDER BY l.timestamp DESC, l.id DESC LIMIT ?`,
      )
      .bind(...params, PAGE_LOGS + 1)
      .all<LogRow>()
  ).results
  if (opts.after) return { logs: rows.slice(0, PAGE_LOGS), more: false, facets: [] }

  // Facets over the newest 1000 that match (not the page's cursor)
  // ponytail: a sample, so counts on a big range are of its newest 1000; a rollup table if that misleads
  const sample = `SELECT l.id FROM logs l WHERE ${base.join(' AND ')} ORDER BY l.timestamp DESC LIMIT 1000`
  const [levels, attributes] = await db.batch<{ key: string; value: string; n: number }>([
    db
      .prepare(
        `SELECT 'level' AS key, level AS value, COUNT(*) AS n FROM logs WHERE id IN (${sample}) GROUP BY level ORDER BY n DESC`,
      )
      .bind(...baseParams),
    db
      .prepare(
        `SELECT key, value, n FROM (SELECT key, value, COUNT(*) AS n,
           ROW_NUMBER() OVER (PARTITION BY key ORDER BY COUNT(*) DESC) AS r,
           SUM(COUNT(*)) OVER (PARTITION BY key) AS total
         FROM log_attributes WHERE log_id IN (${sample}) GROUP BY key, value)
         WHERE r <= 5 ORDER BY total DESC, key, n DESC LIMIT 60`,
      )
      .bind(...baseParams),
  ])
  return {
    logs: rows.slice(0, PAGE_LOGS),
    more: rows.length > PAGE_LOGS,
    facets: [...levels.results, ...attributes.results],
  }
}

/**
 * Logs per bucket and level over a window (the bucket from its span, `intervalFor`), and in `previous` the totals of
 * the span just before it, of the same length, each shifted onto the bucket it's a span behind. Zeros where none.
 */
export async function logsByBucket(db: D1Database, opts: Search, now: number) {
  const { from, to } = spanOf(opts.window, now)
  const span = to - from
  const interval = intervalFor(span)
  const size = SIZE[interval]
  const x = buckets(from, to - 1, interval)
  const { where, params } = conditions(opts, now)
  const filter = where.map((w) => ` AND ${w}`).join('')
  // `%` reads its operands as integers, so the buckets are whole ms however D1 binds the numbers
  const [current, before] = await db.batch<{ at: number; level: string; count: number }>([
    db
      .prepare(
        `SELECT l.timestamp - l.timestamp % ? AS at, l.level, COUNT(*) AS count FROM logs l
         WHERE l.timestamp >= ? AND l.timestamp < ?${filter} GROUP BY at, l.level`,
      )
      .bind(size, from, to, ...params),
    db
      .prepare(
        `SELECT (l.timestamp + ?) - (l.timestamp + ?) % ? AS at, '' AS level, COUNT(*) AS count FROM logs l
         WHERE l.timestamp >= ? AND l.timestamp < ?${filter} GROUP BY at`,
      )
      .bind(span, span, size, from - span, from, ...params),
  ])
  const index = new Map(x.map((at, i) => [at, i]))
  const previous = x.map(() => 0)
  for (const r of before.results) {
    const i = index.get(r.at)
    if (i !== undefined) previous[i] += r.count
  }
  return { from, to, x, interval, levels: fill(current.results, x), previous }
}

/** The daily cron: logs past their project's retention */
export async function pruneLogs(db: D1Database, now: number) {
  await db
    .prepare(
      `DELETE FROM logs WHERE id IN (SELECT l.id FROM logs l JOIN projects p ON p.id = l.project_id
       WHERE l.timestamp < ? - p.log_retention_days * 86400000 LIMIT 5000)`,
    )
    .bind(now)
    .run()
}
