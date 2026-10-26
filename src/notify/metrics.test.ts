import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { evaluateMetricAlerts, metricLine, metricQueryError, metricValue, stateFor } from './metrics'
import { noticeLine } from './notice'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 9, 26, 12, 30)
const hourOf = (ms: number) => ms - (ms % HOUR)

function setup(alert: string) {
  const DB = sqliteD1()
  DB.sqlite.exec(`
    INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'pocketband', 'pocketband', 'k', 0);
    INSERT INTO issues (id, project_id, fingerprint, title, first_seen, last_seen) VALUES (1, 1, 'f', 'Crash', 0, 0);
    INSERT INTO metric_alerts (id, project_id, name, metric, query, window_hours, direction, warning, critical, created_by, created_at)
      VALUES ${alert};`)
  return { DB, PUBLIC_URL: 'https://crashyard.example.com' }
}
const errors = (env: ReturnType<typeof setup>, count: number, environment = 'production') =>
  env.DB.sqlite.exec(`INSERT INTO event_hours (project_id, issue_id, hour, level, release, environment, count)
    VALUES (1, 1, ${hourOf(NOW)}, 'error', '1.0', '${environment}', ${count})
    ON CONFLICT DO UPDATE SET count = excluded.count`)

describe('metric alerts', () => {
  it('send one critical on crossing, nothing while it stays, one resolved on recovery', async () => {
    const env = setup("(1, 1, 'Error spike', 'errors', 'environment:production', 1, 'above', 50, 100, 'm', 0)")
    errors(env, 20)
    expect(await evaluateMetricAlerts(env, NOW)).toEqual([])
    errors(env, 150)
    errors(env, 500, 'staging') // outside the filter
    const [critical, ...rest] = await evaluateMetricAlerts(env, NOW)
    expect(rest).toEqual([])
    expect(critical).toMatchObject({ kind: 'metric_critical', issue: { title: 'Error spike' } })
    expect(noticeLine(critical)).toBe('pocketband · Errors 150, above 100 · Critical')
    expect(await evaluateMetricAlerts(env, NOW + 5 * 60_000)).toEqual([])
    errors(env, 70)
    expect((await evaluateMetricAlerts(env, NOW)).map((n) => n.kind)).toEqual(['metric_warning'])
    errors(env, 10)
    const [resolved] = await evaluateMetricAlerts(env, NOW)
    expect(resolved.kind).toBe('metric_resolved')
    expect(noticeLine(resolved)).toBe('pocketband · Errors 10 · Resolved')
    expect(env.DB.sqlite.prepare('SELECT state, value FROM metric_alerts').get()).toEqual({ state: 'ok', value: 10 })
  })

  it('work below a value, for crash-free sessions over whole days', async () => {
    const env = setup("(1, 1, 'Crash-free', 'crash_free_sessions', '', 24, 'below', 99, 98, 'm', 0)")
    // Nothing to read keeps the state
    expect(await evaluateMetricAlerts(env, NOW)).toEqual([])
    env.DB.sqlite.exec(`INSERT INTO sessions_daily (project_id, release, environment, day, started, crashed)
      VALUES (1, '1.0', 'production', '2026-10-26', 1000, 29)`)
    const [notice] = await evaluateMetricAlerts(env, NOW)
    expect(noticeLine(notice)).toBe('pocketband · Crash-free sessions 97.1%, below 98% · Critical')
    env.DB.sqlite.exec('UPDATE sessions_daily SET crashed = 1')
    expect((await evaluateMetricAlerts(env, NOW)).map((n) => n.kind)).toEqual(['metric_resolved'])
  })

  it('read logs by level from log_hours, and by attribute from the logs', async () => {
    const env = setup("(1, 1, 'Logs', 'log_count', 'level:warning', 1, 'above', NULL, 1, 'm', 0)")
    env.DB.sqlite.exec(
      `INSERT INTO log_hours (project_id, hour, level, count) VALUES (1, ${hourOf(NOW)}, 'warn', 7), (1, ${hourOf(NOW)}, 'info', 3)`,
    )
    const alert = { project_id: 1, metric: 'log_count' as const, window_hours: 1 }
    expect(await metricValue(env.DB, { ...alert, query: 'level:warning' }, NOW)).toBe(7)
    expect(await metricValue(env.DB, { ...alert, query: '' }, NOW)).toBe(10)
    expect(await metricValue(env.DB, { ...alert, query: 'song:intro' }, NOW)).toBe(0)
  })

  it('compare strictly, and say what each filter takes', () => {
    const above = { direction: 'above' as const, warning: 50, critical: 100 }
    expect([49, 50, 51, 100, 101].map((v) => stateFor(above, v))).toEqual([
      'ok',
      'ok',
      'warning',
      'warning',
      'critical',
    ])
    expect(stateFor({ direction: 'below', warning: null, critical: 98 }, 97.9)).toBe('critical')
    expect(metricLine({ metric: 'p95', direction: 'above', warning: null, critical: 1000 }, 1234.4, 'critical')).toBe(
      'p95 duration 1,234 ms, above 1,000 ms · Critical',
    )
    expect(metricQueryError('errors', 'environment:production release:1.*')).toBeNull()
    expect(metricQueryError('errors', 'os:iOS')).toBe(
      'Errors can be filtered by environment, release and level, such as environment:production.',
    )
    expect(metricQueryError('log_count', 'song:intro level:error')).toBeNull()
    expect(metricQueryError('p95', 'project:a')).toMatch(/Pick the project/)
  })
})
