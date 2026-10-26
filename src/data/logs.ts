// Logs: the explorer's page of logs (newest first, searched, within a time range), the facets over what matched,
// what's newer than the newest shown (the live tail), and how many there were per bucket of time, by level.
import { logFilter, tokenize } from '../search/query'
import { buckets, fill, type Interval, intervalFor, SIZE, slugsOf } from './charts'

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

const HOUR = SIZE['1h']

/**
 * Whether a chart can read `log_hours` instead of every log: buckets of an hour or a day, a span of whole hours (so
 * the span before shifts each hour onto one bucket), and a search of nothing but `level` and `project` (the
 * rollup's columns; a word or any other key needs the logs)
 */
export function readsHours(query: string, interval: Interval, span: number) {
  return (
    (interval === '1h' || interval === '1d') &&
    span % HOUR === 0 &&
    tokenize(query).every((t) => t.key === 'level' || t.key === 'project')
  )
}

/**
 * Logs over spans `[from, to)` as a table `l` of (ts, level, project_id, n) that the searches' `l.level` and
 * `l.project_id` read: each span's whole hours from `log_hours`, the part-hours at its ends from the logs themselves
 */
export function hourly(spans: [number, number][]): { sql: string; params: number[] } {
  const parts: string[] = []
  const params: number[] = []
  for (const [from, to] of spans) {
    const start = Math.min(Math.ceil(from / HOUR) * HOUR, to)
    const end = Math.max(Math.floor(to / HOUR) * HOUR, start)
    // Two terms a span: D1 allows five in a compound SELECT
    parts.push(
      'SELECT hour AS ts, level, project_id, count AS n FROM log_hours WHERE hour >= ? AND hour < ?',
      `SELECT timestamp, level, project_id, 1 FROM logs
       WHERE (timestamp >= ? AND timestamp < ?) OR (timestamp >= ? AND timestamp < ?)`,
    )
    params.push(start, end, from, start, end, to)
  }
  return { sql: `(${parts.join(' UNION ALL ')})`, params }
}

/**
 * Logs per bucket and level over a window (the bucket from its span, `intervalFor`), and in `previous` the totals of
 * the span just before it, of the same length, each shifted onto the bucket it's a span behind. Zeros where none.
 * Hours and days read `log_hours` when the search allows (`readsHours`).
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
  const [current, before] = await db.batch<{ at: number; level: string; count: number }>(
    readsHours(opts.query, interval, span)
      ? [
          [from, to],
          [from - span, from],
        ].map(([a, b], i) => {
          const source = hourly([[a, b]])
          const shift = i === 0 ? 0 : span
          return db
            .prepare(
              `SELECT (l.ts + ?) - (l.ts + ?) % ? AS at, ${i === 0 ? 'l.level' : "''"} AS level, SUM(l.n) AS count
               FROM ${source.sql} l WHERE 1${filter} GROUP BY 1, 2`,
            )
            .bind(shift, shift, size, ...source.params, ...params)
        })
      : [
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
        ],
  )
  const index = new Map(x.map((at, i) => [at, i]))
  const previous = x.map(() => 0)
  for (const r of before.results) {
    const i = index.get(r.at)
    if (i !== undefined) previous[i] += r.count
  }
  return { from, to, x, interval, levels: fill(current.results, x), previous }
}

// What logs can be grouped by besides an attribute: their own columns (a missing release or environment as ''; a
// project by its id, its slug looked up after)
export const GROUP_COLUMNS: Record<string, string> = {
  level: 'l.level',
  release: "COALESCE(l.release, '')",
  environment: "COALESCE(l.environment, '')",
  project: 'l.project_id',
}
const TOP = 8

/**
 * Logs by one field over a window: a column of `GROUP_COLUMNS` or an attribute (its key bound, only the logs that
 * have it). The 8 values with the most logs, each with its count in the span just before (of the same length), and
 * the rest as one group whose value is `null`; and per bucket, a series for each of those. By level or project over
 * hours or days, it reads `log_hours` when the search allows (`readsHours`).
 */
export async function logGroups(db: D1Database, opts: Search & { groupBy: string }, now: number) {
  const { from, to } = spanOf(opts.window, now)
  const span = to - from
  const interval = intervalFor(span)
  const x = buckets(from, to - 1, interval)
  const { where, params } = conditions(opts, now)
  const filter = where.map((w) => ` AND ${w}`).join('')
  const column = Object.hasOwn(GROUP_COLUMNS, opts.groupBy) ? GROUP_COLUMNS[opts.groupBy] : undefined
  const value = column ?? 'g.value'
  const join = column ? '' : ' JOIN log_attributes g ON g.log_id = l.id AND g.key = ?'
  const key = column ? [] : [opts.groupBy]
  // The logs of spans, with the condition on time each needs: `log_hours` and its parts of hours, or the logs
  const rollup = (opts.groupBy === 'level' || opts.groupBy === 'project') && readsHours(opts.query, interval, span)
  const ts = rollup ? 'l.ts' : 'l.timestamp'
  const n = rollup ? 'l.n' : '1'
  const source = (a: number, b: number, also?: [number, number]) => {
    if (!rollup) return { sql: `logs l${join} WHERE l.timestamp >= ? AND l.timestamp < ?`, params: [...key, a, b] }
    const h = hourly(also ? [also, [a, b]] : [[a, b]])
    return { sql: `${h.sql} l WHERE 1`, params: h.params }
  }
  // One read of both spans: each value's count in the window and in the span before, and every value's totals
  const both = rollup ? source(from, to, [from - span, from]) : source(from - span, to)
  const top = (
    await db
      .prepare(
        `SELECT value, count, previous, total, total_previous FROM (
           SELECT value, count, previous, SUM(count) OVER () AS total, SUM(previous) OVER () AS total_previous FROM (
             SELECT ${value} AS value, SUM(CASE WHEN ${ts} >= ? THEN ${n} ELSE 0 END) AS count,
               SUM(CASE WHEN ${ts} < ? THEN ${n} ELSE 0 END) AS previous
             FROM ${both.sql}${filter} GROUP BY value))
         WHERE count > 0 ORDER BY count DESC, value LIMIT ?`,
      )
      .bind(from, from, ...both.params, ...params, TOP + 1)
      .all<{ value: string | number; count: number; previous: number; total: number; total_previous: number }>()
  ).results
  const total = top[0]?.total ?? 0
  const totalPrevious = top[0]?.total_previous ?? 0
  const shown = top.slice(0, TOP)
  const groups: { value: string | number | null; count: number; previous: number }[] = shown.map((g) => ({
    value: g.value,
    count: g.count,
    previous: g.previous,
  }))
  const sum = (f: (g: (typeof shown)[number]) => number) => shown.reduce((a, g) => a + f(g), 0)
  if (top.length > TOP)
    groups.push({ value: null, count: total - sum((g) => g.count), previous: totalPrevious - sum((g) => g.previous) })

  const series = groups.map((g) => ({ value: g.value, counts: x.map(() => 0) }))
  if (shown.length) {
    const marks = shown.map(() => '?').join(',')
    const window = source(from, to)
    const rows = (
      await db
        .prepare(
          `SELECT ${ts} - ${ts} % ? AS at, CASE WHEN ${value} IN (${marks}) THEN ${value} END AS value,
           SUM(${n}) AS count FROM ${window.sql}${filter} GROUP BY at, 2`,
        )
        .bind(SIZE[interval], ...shown.map((g) => g.value), ...window.params, ...params)
        .all<{ at: number; value: string | number | null; count: number }>()
    ).results
    const index = new Map(x.map((at, i) => [at, i]))
    const of = new Map(series.map((s) => [s.value, s.counts]))
    for (const r of rows) {
      const i = index.get(r.at)
      const counts = of.get(r.value)
      if (i !== undefined && counts) counts[i] += r.count
    }
  }
  // Projects by their slugs, looked up once rather than for every log
  const slugs =
    opts.groupBy === 'project' && shown.length
      ? await slugsOf(
          db,
          shown.map((g) => Number(g.value)),
        )
      : undefined
  const label = (v: string | number | null) => (v === null ? null : (slugs?.get(Number(v)) ?? String(v)))
  return {
    from,
    to,
    x,
    interval,
    total,
    groups: groups.map((g) => ({ ...g, value: label(g.value) })),
    series: series.map((s) => ({ ...s, value: label(s.value) })),
  }
}

/** The daily cron: logs past their project's retention, and the hours of `log_hours` wholly past it */
export async function pruneLogs(db: D1Database, now: number) {
  await db.batch([
    db
      .prepare(
        `DELETE FROM logs WHERE id IN (SELECT l.id FROM logs l JOIN projects p ON p.id = l.project_id
         WHERE l.timestamp < ? - p.log_retention_days * 86400000 LIMIT 5000)`,
      )
      .bind(now),
    // The shortest retention bounds the read by `log_hours_hour`; each row is then held to its own project's
    db
      .prepare(
        `DELETE FROM log_hours WHERE hour <= (SELECT ? - MIN(log_retention_days) * 86400000 - 3600000 FROM projects)
         AND hour <= ? - (SELECT p.log_retention_days FROM projects p WHERE p.id = log_hours.project_id) * 86400000 - 3600000`,
      )
      .bind(now, now),
  ])
}
