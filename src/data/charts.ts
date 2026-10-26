// Charts: counts per bucket of time, filled with zeros, for the charts on the lists.
import type { Filter } from '../search/query'

export type Interval = 'hour' | 'day'
// The periods the issues chart shows, in days
export const CHART_DAYS = [14, 30, 90] as const
export type ChartDays = (typeof CHART_DAYS)[number]
const SIZE: Record<Interval, number> = { hour: 36e5, day: 864e5 }

/** The start of every UTC bucket from the one that holds `from` to the one that holds `to` */
export function buckets(from: number, to: number, interval: Interval): number[] {
  const size = SIZE[interval]
  const out: number[] = []
  for (let at = Math.floor(from / size) * size; at <= to; at += size) out.push(at)
  return out
}

// Most severe first; any other level after them, as it came
export const LEVELS = ['fatal', 'error', 'warning', 'info', 'debug']
const rank = (level: string) => {
  const i = LEVELS.indexOf(level)
  return i === -1 ? LEVELS.length : i
}

/** Sparse rows (a day and level with its count) as a series per level that has any, a count for every day */
export function fill(rows: { day: string; level: string; count: number }[], days: string[]) {
  const at = new Map(days.map((d, i) => [d, i]))
  const series = new Map<string, number[]>()
  for (const r of rows) {
    const i = at.get(r.day)
    if (i === undefined) continue
    let counts = series.get(r.level)
    if (!counts) series.set(r.level, (counts = days.map(() => 0)))
    counts[i] += r.count
  }
  return [...series].map(([level, counts]) => ({ level, counts })).sort((a, b) => rank(a.level) - rank(b.level))
}

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

/** Events per UTC day and level of the issues a filter matches, from `days[0]` to the last of `days` */
export async function issueEventsByDay(db: D1Database, filter: Filter, projectId: number | undefined, days: string[]) {
  if (!days.length) return []
  const f = scoped(filter, projectId)
  return (
    await db
      .prepare(
        `SELECT d.day, i.level, SUM(d.count) AS count FROM issue_days d JOIN issues i ON i.id = d.issue_id
         WHERE d.day >= ? AND d.day <= ?${f.where.map((w) => ` AND ${w}`).join('')}
         GROUP BY d.day, i.level`,
      )
      .bind(days[0], days[days.length - 1], ...f.params)
      .all<{ day: string; level: string; count: number }>()
  ).results
}
