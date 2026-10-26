// Charts: counts per bucket of time, filled with zeros, for the charts on the lists.
import type { Filter } from '../search/query'

export type Interval = '1m' | '5m' | '1h' | '1d'
// The periods the issues chart shows, in days
export const CHART_DAYS = [14, 30, 90] as const
export type ChartDays = (typeof CHART_DAYS)[number]
export const SIZE: Record<Interval, number> = { '1m': 6e4, '5m': 3e5, '1h': 36e5, '1d': 864e5 }

/** The bucket for a span of time: a minute up to an hour, 5 minutes up to 6 hours, an hour up to a week, else a day */
export function intervalFor(span: number): Interval {
  return span <= SIZE['1h'] ? '1m' : span <= 6 * SIZE['1h'] ? '5m' : span <= 7 * SIZE['1d'] ? '1h' : '1d'
}

/** The start of every UTC bucket from the one that holds `from` to the one that holds `to` */
export function buckets(from: number, to: number, interval: Interval): number[] {
  const size = SIZE[interval]
  const out: number[] = []
  for (let at = Math.floor(from / size) * size; at <= to; at += size) out.push(at)
  return out
}

// Most severe first (issues' levels and logs' `warn` and `trace`); any other level after them, as it came
export const LEVELS = ['fatal', 'error', 'warning', 'warn', 'info', 'debug', 'trace']
const rank = (level: string) => {
  const i = LEVELS.indexOf(level)
  return i === -1 ? LEVELS.length : i
}

/**
 * Sparse rows (a bucket, a day or a bucket's start in ms, and a level with its count) as a series per level that has
 * any, a count for every one of `xs`; rows outside `xs` are left out
 */
export function fill<X extends string | number>(rows: { at: X; level: string; count: number }[], xs: X[]) {
  const index = new Map(xs.map((x, i) => [x, i]))
  const series = new Map<string, number[]>()
  for (const r of rows) {
    const i = index.get(r.at)
    if (i === undefined) continue
    let counts = series.get(r.level)
    if (!counts) series.set(r.level, (counts = xs.map(() => 0)))
    counts[i] += r.count
  }
  return [...series].map(([level, counts]) => ({ level, counts })).sort((a, b) => rank(a.level) - rank(b.level))
}

/**
 * The `n` series with the most in them, largest first, and the rest summed bucket by bucket into one row whose value
 * is `null` (none when nothing's left)
 */
export function topWithOther(rows: { value: string; counts: number[] }[], n: number) {
  const total = (r: { counts: number[] }) => r.counts.reduce((a, b) => a + b, 0)
  const sorted = rows.map((r) => ({ ...r, total: total(r) })).sort((a, b) => b.total - a.total)
  const top: { value: string | null; counts: number[] }[] = sorted
    .slice(0, n)
    .map((r) => ({ value: r.value, counts: r.counts }))
  const rest = sorted.slice(n)
  if (rest.length)
    top.push({ value: null, counts: rest[0].counts.map((_, i) => rest.reduce((a, r) => a + (r.counts[i] ?? 0), 0)) })
  return top
}

/** How much more (or less) than before, as a fraction: `null` when there was nothing before */
export const change = (now: number, before: number) => (before ? now / before - 1 : null)

const marks = (n: number) => Array(n).fill('?').join(',')

/** An issue filter's conditions narrowed to a project (the page's) and to the slugs of its `project:` tokens */
export function scoped(f: Filter, projectId: number | undefined) {
  const where = [...f.where]
  const params = [...f.params]
  if (projectId) {
    where.push('i.project_id = ?')
    params.push(projectId)
  }
  if (f.projectSlugs.length) {
    where.push(`i.project_id IN (SELECT id FROM projects WHERE slug IN (${marks(f.projectSlugs.length)}))`)
    params.push(...f.projectSlugs)
  }
  return { where, params }
}

/** Projects' slugs by id */
export async function slugsOf(db: D1Database, ids: number[]) {
  const rows = (
    await db
      .prepare(`SELECT id, slug FROM projects WHERE id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids)
      .all<{ id: number; slug: string }>()
  ).results
  return new Map(rows.map((r) => [r.id, r.slug]))
}

// What issues' events can be split by: the issue's level, or its project (by id, its slug looked up after)
export const EVENT_GROUPS = { level: 'i.level', project: 'i.project_id' }
export type EventGroup = keyof typeof EVENT_GROUPS

/**
 * Events per UTC day and level of the issues a filter matches, from `days[0]` to the last of `days`; with `by`
 * `project`, `level` holds the project's slug instead
 */
export async function issueEventsByDay(
  db: D1Database,
  filter: Filter,
  projectId: number | undefined,
  days: string[],
  by: EventGroup = 'level',
) {
  if (!days.length) return []
  const f = scoped(filter, projectId)
  const rows = (
    await db
      .prepare(
        `SELECT d.day AS at, ${EVENT_GROUPS[by]} AS level, SUM(d.count) AS count
         FROM issue_days d JOIN issues i ON i.id = d.issue_id
         WHERE d.day >= ? AND d.day <= ?${f.where.map((w) => ` AND ${w}`).join('')}
         GROUP BY d.day, 2`,
      )
      .bind(days[0], days[days.length - 1], ...f.params)
      .all<{ at: string; level: string | number; count: number }>()
  ).results
  // Projects by their slugs, looked up once rather than for every row
  const slugs =
    by === 'project' && rows.length ? await slugsOf(db, [...new Set(rows.map((r) => Number(r.level)))]) : undefined
  return rows.map((r) => ({ ...r, level: slugs?.get(Number(r.level)) ?? String(r.level) }))
}
