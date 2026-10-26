// Metric alerts: a number over a window, read every 5 minutes, alerting when it crosses its warning or critical value
// and when it comes back. Only a change of state makes a notice.
import { percentile } from '../performance/histogram'
import { logFilter, matchAny, tokenize } from '../search/query'
import type { Notice } from './notice'

const HOUR = 3_600_000

export type Metric = 'errors' | 'users' | 'crash_free_sessions' | 'p95' | 'failure_rate' | 'log_count'
export type MetricState = 'ok' | 'warning' | 'critical'
export type Direction = 'above' | 'below'
export const WINDOW_HOURS = [1, 6, 24] as const

/** Each metric: its name, its unit, and the keys its filter takes with the column each reads (logs take any) */
export const METRICS: Record<
  Metric,
  { label: string; unit: 'count' | 'percent' | 'ms'; keys?: Record<string, string> }
> = {
  errors: { label: 'Errors', unit: 'count', keys: { environment: 'environment', release: 'release', level: 'level' } },
  users: {
    label: 'Users with errors',
    unit: 'count',
    keys: { environment: 'environment', release: 'release', level: 'level' },
  },
  crash_free_sessions: {
    label: 'Crash-free sessions',
    unit: 'percent',
    keys: { environment: 'environment', release: 'release' },
  },
  p95: { label: 'p95 duration', unit: 'ms', keys: { release: 'release', transaction: 'name' } },
  failure_rate: { label: 'Failure rate', unit: 'percent', keys: { release: 'release', transaction: 'name' } },
  log_count: { label: 'Logs', unit: 'count' },
}

export type MetricAlert = {
  id: number
  project_id: number
  name: string
  metric: Metric
  query: string
  window_hours: number
  direction: Direction
  warning: number | null
  critical: number
  state: MetricState
  value: number | null
  changed_at: number | null
}

/** Why an alert's filter can't be read for its metric, or null when it can */
export function metricQueryError(metric: Metric, query: string): string | null {
  const keys = METRICS[metric].keys
  for (const t of tokenize(query)) {
    if (t.key === 'project') return 'Pick the project above. The filter narrows within it.'
    if (!keys) continue // logs: the logs search, attributes too
    if (!t.key || !keys[t.key] || t.op !== ':') {
      const names = Object.keys(keys)
      return `${METRICS[metric].label} can be filtered by ${names.slice(0, -1).join(', ')} and ${names.at(-1)}, such as ${names[0]}:production.`
    }
  }
  return null
}

/** SQL conditions over a table's columns, from a filter `metricQueryError` passed */
function columns(query: string, keys: Record<string, string>, alias: Record<string, string> = {}) {
  const where: string[] = []
  const params: unknown[] = []
  for (const t of tokenize(query)) {
    const column = t.key && keys[t.key]
    if (!column || t.op !== ':') continue
    const [sql, values] = matchAny(
      column,
      (t.values ?? [t.value]).map((v) => alias[v] ?? v),
    )
    where.push(t.negate ? `NOT (${sql})` : sql)
    params.push(...values)
  }
  return { sql: where.map((w) => ` AND ${w}`).join(''), params }
}

/**
 * The metric's value now, or null when there's nothing to read (no sessions, no transactions). Hourly tables count
 * the window's hours and the current one, so a 1-hour window reads up to 2 hours: never less than the window
 */
export async function metricValue(
  db: D1Database,
  alert: Pick<MetricAlert, 'project_id' | 'metric' | 'query' | 'window_hours'>,
  now: number,
): Promise<number | null> {
  const from = now - alert.window_hours * HOUR
  const fromHour = from - (from % HOUR)
  const def = METRICS[alert.metric]
  const f = def.keys ? columns(alert.query, def.keys) : { sql: '', params: [] }
  const one = (sql: string, ...params: unknown[]) =>
    db
      .prepare(sql)
      .bind(...params, ...f.params)
      .first<Record<string, number | null>>()
  switch (alert.metric) {
    case 'errors': {
      const row = await one(
        `SELECT COALESCE(SUM(count), 0) AS v FROM event_hours WHERE project_id = ? AND hour >= ?${f.sql}`,
        alert.project_id,
        fromHour,
      )
      return row?.v ?? 0
    }
    case 'users': {
      // `events` is exact to the window; events stored before 0014 have no user
      const row = await one(
        `SELECT COUNT(DISTINCT user_hash) AS v FROM events WHERE project_id = ? AND received > ? AND user_hash IS NOT NULL${f.sql}`,
        alert.project_id,
        from,
      )
      return row?.v ?? 0
    }
    case 'crash_free_sessions': {
      // Sessions are counted per UTC day: every day the window touches
      const row = await one(
        `SELECT SUM(started) AS started, SUM(crashed) AS crashed FROM sessions_daily WHERE project_id = ? AND day >= ?${f.sql}`,
        alert.project_id,
        new Date(from).toISOString().slice(0, 10),
      )
      return row?.started ? (1 - (row.crashed ?? 0) / row.started) * 100 : null
    }
    case 'p95': {
      const rows = (
        await db
          .prepare(
            `SELECT bucket, SUM(count) AS n FROM transaction_buckets WHERE project_id = ? AND hour >= ?${f.sql} GROUP BY bucket`,
          )
          .bind(alert.project_id, fromHour, ...f.params)
          .all<{ bucket: number; n: number }>()
      ).results
      return percentile(new Map(rows.map((r) => [r.bucket, r.n])), 0.95)
    }
    case 'failure_rate': {
      const row = await one(
        `SELECT SUM(count) AS n, SUM(errors) AS errors FROM transaction_hours WHERE project_id = ? AND hour >= ?${f.sql}`,
        alert.project_id,
        fromHour,
      )
      return row?.n ? ((row.errors ?? 0) / row.n) * 100 : null
    }
    case 'log_count': {
      const tokens = tokenize(alert.query)
      // Only levels: `log_hours`, without reading a log
      if (tokens.every((t) => t.key === 'level' && t.op === ':')) {
        const levels = columns(alert.query, { level: 'level' }, { warning: 'warn', critical: 'fatal' })
        const row = await db
          .prepare(`SELECT COALESCE(SUM(count), 0) AS v FROM log_hours WHERE project_id = ? AND hour >= ?${levels.sql}`)
          .bind(alert.project_id, fromHour, ...levels.params)
          .first<{ v: number }>()
        return row?.v ?? 0
      }
      const lf = logFilter(alert.query, now)
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS v FROM logs l WHERE l.project_id = ? AND l.timestamp > ?${lf.where.map((w) => ` AND ${w}`).join('')}`,
        )
        .bind(alert.project_id, from, ...lf.params)
        .first<{ v: number }>()
      return row?.v ?? 0
    }
  }
}

/** The state a value puts an alert in: past critical, else past warning, else ok; past is strictly above or below */
export function stateFor(alert: Pick<MetricAlert, 'direction' | 'warning' | 'critical'>, value: number): MetricState {
  const past = (threshold: number) => (alert.direction === 'above' ? value > threshold : value < threshold)
  if (past(alert.critical)) return 'critical'
  if (alert.warning !== null && past(alert.warning)) return 'warning'
  return 'ok'
}

const numbers = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

/** A value in its unit: 97.1%, 1,200 ms, 340. Crash-free is floored to a tenth, so a crash never reads 100% */
export function metricText(metric: Metric, value: number): string {
  const unit = METRICS[metric].unit
  if (unit === 'percent')
    return `${numbers.format(metric === 'crash_free_sessions' ? Math.floor(value * 10) / 10 : value)}%`
  if (unit === 'ms') return `${numbers.format(Math.round(value))} ms`
  return numbers.format(value)
}

const STATE_WORD: Record<MetricState, string> = { ok: 'Resolved', warning: 'Warning', critical: 'Critical' }

/** "Crash-free sessions 97.1%, below 98% · Critical", or "Crash-free sessions 99.2% · Resolved" */
export function metricLine(
  alert: Pick<MetricAlert, 'metric' | 'direction' | 'warning' | 'critical'>,
  value: number,
  state: MetricState,
) {
  const now = `${METRICS[alert.metric].label} ${metricText(alert.metric, value)}`
  const threshold = state === 'critical' ? alert.critical : state === 'warning' ? alert.warning : null
  return [
    threshold === null ? now : `${now}, ${alert.direction} ${metricText(alert.metric, threshold)}`,
    STATE_WORD[state],
  ].join(' · ')
}

const KIND: Record<MetricState, Notice['kind']> = {
  ok: 'metric_resolved',
  warning: 'metric_warning',
  critical: 'metric_critical',
}
const LEVEL: Record<MetricState, string> = { ok: 'info', warning: 'warning', critical: 'error' }

/**
 * Every 5 minutes: each alert's value, and a notice when its state changed. The state is written only by a change
 * from the one read, so two runs at once send it once
 */
export async function evaluateMetricAlerts(
  env: { DB: D1Database; PUBLIC_URL?: string },
  now: number,
  deadline = Date.now() + 20_000,
): Promise<Notice[]> {
  const alerts = (
    await env.DB.prepare(
      'SELECT a.*, p.slug, p.name AS project_name FROM metric_alerts a JOIN projects p ON p.id = a.project_id ORDER BY a.id',
    ).all<MetricAlert & { slug: string; project_name: string }>()
  ).results
  const notices: Notice[] = []
  for (const alert of alerts) {
    if (Date.now() > deadline) break
    let value: number | null
    try {
      value = await metricValue(env.DB, alert, now)
    } catch (error) {
      console.error(`metric alert ${alert.id}`, error)
      continue
    }
    // Nothing to read keeps the state as it was
    const state = value === null ? alert.state : stateFor(alert, value)
    if (state === alert.state) {
      if (value !== alert.value)
        await env.DB.prepare('UPDATE metric_alerts SET value = ? WHERE id = ?').bind(value, alert.id).run()
      continue
    }
    const changed = await env.DB.prepare(
      'UPDATE metric_alerts SET state = ?, value = ?, changed_at = ? WHERE id = ? AND state = ? RETURNING id',
    )
      .bind(state, value, now, alert.id, alert.state)
      .first()
    if (!changed || value === null) continue
    notices.push({
      kind: KIND[state],
      project: { id: alert.project_id, slug: alert.slug, name: alert.project_name },
      issue: {
        id: alert.id,
        title: alert.name,
        culprit: metricLine(alert, value, state),
        level: LEVEL[state],
        count: 0,
      },
      event: { level: LEVEL[state] },
      url: `${env.PUBLIC_URL ?? ''}/notifications`,
    })
  }
  return notices
}
