// Logs: the explorer's page of logs (newest first, searched, within a time range), the facets over what matched,
// and what's newer than the newest shown (the live tail).
import { logFilter } from '../search/query'

export const PAGE_LOGS = 100
export const RANGES = { '1h': 36e5, '24h': 864e5, '7d': 6048e5, '30d': 2592e6 } as const
export type Range = keyof typeof RANGES

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

export async function listLogs(
  db: D1Database,
  opts: { query: string; projectId?: number; range: Range; before?: Cursor; after?: Cursor },
  now: number,
) {
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
  where.push('l.timestamp >= ?')
  params.push(now - RANGES[opts.range])
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
