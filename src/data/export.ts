// Logs as files: the current search as CSV or JSON Lines, 10,000 lines at most.
import { conditions, type LogRow, spanOf, type Window } from './logs'

export const MAX_LINES = 10_000
export const FORMATS = { csv: 'text/csv; charset=utf-8', jsonl: 'application/x-ndjson; charset=utf-8' } as const
export type Format = keyof typeof FORMATS

const COLUMNS = ['timestamp', 'level', 'project', 'release', 'environment', 'trace_id', 'body', 'attributes'] as const

/**
 * One CSV field: quoted when it holds a quote, a comma or a line break, its quotes doubled. Text a spreadsheet would
 * read as a formula (starting `=` `+` `-` `@`, a tab or a return) gets a `'` in front, so opening the file runs nothing
 */
export function csvField(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

/** Rows as CSV, a header first: `MAX_LINES` rows at most, a row a record whatever line breaks are quoted in it */
export function toCsv(columns: readonly string[], rows: Record<string, unknown>[]): string {
  const lines = [
    columns.join(','),
    ...rows.slice(0, MAX_LINES).map((r) => columns.map((c) => csvField(r[c])).join(',')),
  ]
  return `${lines.join('\r\n')}\r\n`
}

/** Rows as JSON Lines: one object a line, `MAX_LINES` at most */
export function toJsonLines(rows: Record<string, unknown>[]): string {
  return rows
    .slice(0, MAX_LINES)
    .map((r) => `${JSON.stringify(r)}\n`)
    .join('')
}

/** The newest `MAX_LINES` logs of a search, as the list shows them, with times in UTC */
export async function exportLogs(
  db: D1Database,
  opts: { query: string; projectId?: number; window: Window },
  format: Format,
  now: number,
) {
  const { where, params } = conditions(opts, now)
  const span = spanOf(opts.window, now)
  const rows = (
    await db
      .prepare(
        `SELECT l.id, p.slug AS project, l.timestamp, l.level, l.body, l.attributes, l.release, l.environment, l.trace_id
         FROM logs l JOIN projects p ON p.id = l.project_id
         WHERE l.timestamp >= ? AND l.timestamp < ?${where.map((w) => ` AND ${w}`).join('')}
         ORDER BY l.timestamp DESC, l.id DESC LIMIT ?`,
      )
      .bind(span.from, span.to, ...params, MAX_LINES)
      .all<LogRow>()
  ).results
  const records = rows.map((r) => ({
    timestamp: new Date(r.timestamp).toISOString(),
    level: r.level,
    project: r.project,
    release: r.release,
    environment: r.environment,
    trace_id: r.trace_id,
    body: r.body,
    attributes: format === 'csv' ? r.attributes : (JSON.parse(r.attributes) as unknown),
  }))
  return format === 'csv' ? toCsv(COLUMNS, records) : toJsonLines(records)
}
