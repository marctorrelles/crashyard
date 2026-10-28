// Logs as files: the current search as CSV or JSON Lines, 10,000 lines at most, streamed.
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

const PAGE = 1000
const encoder = new TextEncoder()

/** A log as the file has it: times in UTC, attributes as JSON text in CSV and as an object in JSON Lines */
const record = (r: LogRow, format: Format) => ({
  timestamp: new Date(r.timestamp).toISOString(),
  level: r.level,
  project: r.project,
  release: r.release,
  environment: r.environment,
  trace_id: r.trace_id,
  body: r.body,
  attributes: format === 'csv' ? r.attributes : (JSON.parse(r.attributes) as unknown),
})
const line = (r: Record<string, unknown>, format: Format) =>
  format === 'csv' ? `${COLUMNS.map((c) => csvField(r[c])).join(',')}\r\n` : `${JSON.stringify(r)}\n`

/**
 * The newest `MAX_LINES` logs of a search, as the list shows them, as a stream: read a thousand at a time by the
 * list's own cursor and written as they come, so a search of long logs never sits whole in memory (as rows, records
 * and text, 10,000 logs of 10 KB passed the isolate's 128 MB). A search that can't be read throws before it starts
 */
export async function exportLogs(
  db: D1Database,
  opts: { query: string; projectId?: number; window: Window },
  format: Format,
  now: number,
): Promise<ReadableStream<Uint8Array>> {
  const { where, params } = conditions(opts, now)
  const span = spanOf(opts.window, now)
  const page = (before?: LogRow) =>
    db
      .prepare(
        `SELECT l.id, p.slug AS project, l.timestamp, l.level, l.body, l.attributes, l.release, l.environment, l.trace_id
         FROM logs l JOIN projects p ON p.id = l.project_id
         WHERE l.timestamp >= ? AND l.timestamp < ?${where.map((w) => ` AND ${w}`).join('')}
           ${before ? 'AND (l.timestamp < ? OR (l.timestamp = ? AND l.id < ?))' : ''}
         ORDER BY l.timestamp DESC, l.id DESC LIMIT ?`,
      )
      .bind(
        span.from,
        span.to,
        ...params,
        ...(before ? [before.timestamp, before.timestamp, before.id] : []),
        Math.min(PAGE, MAX_LINES - sent),
      )
      .all<LogRow>()
  let sent = 0
  let last: LogRow | undefined
  // The first page read now, so a search D1 refuses fails the request instead of the file halfway
  let next: D1Result<LogRow> | undefined = await page()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (format === 'csv') controller.enqueue(encoder.encode(`${COLUMNS.join(',')}\r\n`))
    },
    async pull(controller) {
      const { results } = next ?? (await page(last))
      next = undefined
      if (results.length)
        controller.enqueue(encoder.encode(results.map((r) => line(record(r, format), format)).join('')))
      sent += results.length
      last = results.at(-1)
      if (results.length < PAGE || sent >= MAX_LINES) controller.close()
    },
  })
}
