import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { bucketOf, percentile } from '../performance/histogram'
import { logGroups, logsByBucket } from './logs'
import { TEMPLATES } from './templates'
import {
  aggregateError,
  applyFilters,
  parseWidgets,
  readWidgets,
  upgradeWidget,
  type Widget,
  widgetData,
  type WidgetV1,
} from './widgets'

const HOUR = 36e5
const NOW = Date.UTC(2026, 9, 26, 12) // on the hour: a 24-hour chart is 24 hourly buckets
const DAY = 864e5

/** Two projects, two issues, events per hour, logs with a duration, transactions, sessions and monitors */
function seeded() {
  const db = sqliteD1()
  db.sqlite.exec(`
    INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'pocketband', 'pocketband', 'k1', 0),
      (2, 'caliu', 'Caliu', 'k2', 0);
    INSERT INTO issues (id, project_id, fingerprint, title, level, status, first_seen, last_seen, count)
      VALUES (1, 1, 'a', 'Audio engine crashed', 'fatal', 'unresolved', ${NOW - 30 * DAY}, ${NOW}, 9),
             (2, 2, 'b', 'Sync failed', 'error', 'unresolved', ${NOW - 2 * HOUR}, ${NOW}, 6);`)
  // Issue 1: 1 event an hour for the last 3 hours in 1.0/production, 2 in 1.1 an hour ago; issue 2: 2 an hour, staging
  const hours: [number, number, string, string, string, number][] = [
    [1, 1, 'fatal', '1.0', 'production', 1],
    [1, 2, 'fatal', '1.0', 'production', 1],
    [1, 3, 'fatal', '1.0', 'production', 1],
    [1, 1, 'fatal', '1.1', 'production', 2],
    [2, 1, 'error', '1.1', 'staging', 2],
    [2, 2, 'error', '1.1', 'staging', 2],
    // The day before: 4
    [1, 30, 'fatal', '1.0', 'production', 4],
  ]
  for (const [issue, ago, level, release, environment, count] of hours)
    db.sqlite.exec(`INSERT INTO event_hours (project_id, issue_id, hour, level, release, environment, count)
      VALUES (${issue}, ${issue}, ${NOW - ago * HOUR}, '${level}', '${release}', '${environment}', ${count})`)
  // Events with users, for count_unique(user)
  for (const [i, user] of ['u1', 'u1', 'u2', null].entries())
    db.sqlite
      .exec(`INSERT INTO events (id, project_id, issue_id, timestamp, received, level, platform, release, data, user_hash)
      VALUES ('e${i}', 1, 1, 0, ${NOW - (i + 1) * HOUR}, 'fatal', 'cocoa', '1.0', '{}', ${user ? `'${user}'` : 'NULL'})`)
  // Logs: durations 10…100 ms on /a, and 1000 on /b, in the last hour; one without a duration
  const logs: [string, string, string, number | null][] = [
    ...Array.from({ length: 10 }, (_, i): [string, string, string, number] => ['info', '1.0', '/a', (i + 1) * 10]),
    ['error', '1.1', '/b', 1000],
    ['error', '1.1', '/b', null],
  ]
  for (const [i, [level, release, route, duration]] of logs.entries()) {
    const attributes = JSON.stringify(duration === null ? { route } : { route, duration })
    db.sqlite
      .exec(`INSERT INTO logs (id, project_id, timestamp, received, level, body, attributes, release, environment)
      VALUES (${i + 1}, 1, ${NOW - 30 * 6e4 + i}, 0, '${level}', 'took a while', '${attributes}', '${release}', 'production');
      INSERT INTO log_attributes (log_id, project_id, key, value) VALUES (${i + 1}, 1, 'route', '${route}');`)
  }
  db.sqlite.exec(`INSERT INTO log_hours (project_id, hour, level, count) VALUES (1, ${NOW - HOUR}, 'info', 10),
    (1, ${NOW - HOUR}, 'error', 2)`)
  return db
}

const window = { range: '24h' } as const
const v1 = (w: Partial<WidgetV1>): WidgetV1 => ({
  id: '0a1b2c3d',
  title: 'A widget',
  dataset: 'events',
  query: '',
  display: 'number',
  width: 1,
  ...w,
})
const v2 = (w: Partial<Widget>): Widget => ({
  id: '0a1b2c3d',
  title: 'A widget',
  dataset: 'events',
  display: 'number',
  queries: [{ query: '', aggregate: 'count' }],
  width: 1,
  ...w,
})

describe('upgradeWidget', () => {
  it('turns every stored v1 shape into v2', () => {
    expect(upgradeWidget(v1({ query: 'level:error', groupBy: 'release', dataset: 'logs', display: 'bar' }))).toEqual({
      id: '0a1b2c3d',
      title: 'A widget',
      dataset: 'logs',
      display: 'bar',
      queries: [{ query: 'level:error', aggregate: 'count' }],
      groupBy: ['release'],
      width: 1,
    })
    expect(upgradeWidget(v1({}))).not.toHaveProperty('groupBy')
    // Stored v1 widgets read as v2, and save back unchanged
    const stored = [
      v1({ dataset: 'issues', display: 'list', query: 'is:unresolved' }),
      v1({ id: '00000002', dataset: 'events', display: 'bar', groupBy: 'project' }),
      v1({ id: '00000003', dataset: 'logs', display: 'table', groupBy: 'release', query: 'level:error' }),
    ]
    const read = readWidgets(JSON.stringify(stored))
    expect(read.map((w) => w.invalid)).toEqual([undefined, undefined, undefined])
    expect(read).toEqual(stored.map(upgradeWidget))
    expect(parseWidgets(read)).toEqual(read)
  })

  it('shows the same as before for each v1 shape', async () => {
    const db = seeded()
    const data = (w: WidgetV1, projectId?: number) => {
      const [widget] = readWidgets(JSON.stringify([w]))
      return widgetData(db, widget, projectId, window, NOW)
    }
    // Issues: a count right now against those first seen before the window, and the list by events
    expect(await data(v1({ dataset: 'issues', query: 'is:unresolved' }))).toEqual({
      kind: 'number',
      values: [{ value: 2, previous: 1, unit: 'count' }],
    })
    const list = await data(v1({ dataset: 'issues', display: 'list', query: 'is:unresolved' }))
    expect(list.kind === 'list' && list.issues.map((i) => i.id)).toEqual([1, 2])
    // Events: a count against the day before, and a table by level
    expect(await data(v1({}))).toEqual({ kind: 'number', values: [{ value: 9, previous: 4, unit: 'count' }] })
    const table = await data(v1({ display: 'table' }))
    expect(table).toMatchObject({
      kind: 'table',
      fields: ['level'],
      rows: [
        { group: ['fatal'], values: [5], previous: [4] },
        { group: ['error'], values: [4], previous: [0] },
      ],
    })
    const byProject = await data(v1({ display: 'bar', groupBy: 'project' }))
    if (byProject.kind !== 'series') throw new Error(JSON.stringify(byProject))
    expect(byProject.series.map((s) => s.value)).toEqual(['pocketband', 'caliu'])
    // Logs: what the logs page's own functions say
    const logs = { query: 'level:error', window, projectId: undefined }
    const c = await logsByBucket(db, logs, NOW)
    expect(await data(v1({ dataset: 'logs', query: 'level:error' }))).toEqual({
      kind: 'number',
      values: [{ value: 2, previous: c.previous.reduce((a, b) => a + b, 0), unit: 'count' }],
    })
    const g = await logGroups(db, { ...logs, groupBy: 'release' }, NOW)
    expect(await data(v1({ dataset: 'logs', display: 'table', groupBy: 'release', query: 'level:error' }))).toEqual({
      kind: 'table',
      fields: ['release'],
      units: ['count'],
      rows: g.groups.map((r) => ({ group: [r.value], values: [r.count], previous: [r.previous] })),
    })
    const bars = await data(v1({ dataset: 'logs', display: 'bar' }))
    expect(bars.kind === 'series' && bars.series.map((s) => [s.value, s.counts.reduce((a, b) => a! + b!, 0)])).toEqual([
      ['error', 2],
      ['info', 10],
    ])
  })
})

describe('parseWidgets', () => {
  it('accepts every template', () => {
    for (const t of TEMPLATES) expect(parseWidgets(t.widgets), t.name).toEqual(t.widgets)
  })

  it('refuses an aggregate a dataset can’t compute, naming what it can', () => {
    expect(() => parseWidgets([v2({ queries: [{ query: '', aggregate: 'p95(duration)' }] })])).toThrow(
      'Issue events can show count or count_unique(user).',
    )
    expect(aggregateError('transactions', 'p95(cpu)')).toBe(
      'Transactions can show count, failure_rate or avg, p50, p75, p95, p99 of duration, or p50 to p99 of a vital such as lcp, such as p95(duration).',
    )
    expect(aggregateError('logs', 'p95(duration)')).toBeNull()
    expect(aggregateError('logs', 'crash_free_rate')).toMatch(/^Logs can show count or avg, sum, min, max/)
    expect(aggregateError('sessions', 'crash_free_rate')).toBeNull()
  })

  it.each([
    ['four queries', { queries: Array.from({ length: 4 }, () => ({ query: '', aggregate: 'count' })) }],
    ['no query', { queries: [] }],
    ['three group-bys', { groupBy: ['level', 'release', 'environment'] }],
    ['a group-by the dataset has not', { groupBy: ['song'] }],
    [
      'a field filter a dataset can’t read',
      { dataset: 'sessions', queries: [{ query: 'os:iOS', aggregate: 'count' }] },
    ],
    ['a limit of 51', { limit: 51 }],
    ['a sort by size', { sort: { by: 'size', dir: 'asc' } }],
    ['thresholds as text', { thresholds: { warning: '1', critical: 2, direction: 'above' } }],
    ['markdown with no text', { dataset: 'markdown', display: 'text', text: ' ' }],
    ['markdown over 4000', { dataset: 'markdown', display: 'text', text: 'x'.repeat(4001) }],
  ])('rejects %s', (_, change) => {
    expect(() => parseWidgets([{ ...v2({}), ...change }])).toThrow()
  })
})

describe('datasets', () => {
  it('reads events by hour: 24 buckets over 24 hours, filtered by environment and release', async () => {
    const db = seeded()
    const bars = await widgetData(db, v2({ display: 'bar' }), undefined, window, NOW)
    expect(bars.kind === 'series' && bars.x).toHaveLength(24)
    const filtered = await widgetData(db, v2({ display: 'bar' }), undefined, window, NOW, {
      environment: 'production',
      release: '1.1',
    })
    if (filtered.kind !== 'series') throw new Error(filtered.kind)
    expect(filtered.series.map((s) => [s.value, s.counts.reduce((a, b) => a! + b!, 0)])).toEqual([['fatal', 2]])
    expect(filtered.series[0].counts.at(-1)).toBe(2) // an hour ago, the last bucket
    // The filter bar's keys go only where a dataset knows them
    expect(applyFilters(v2({ dataset: 'monitors' }), { query: 'os:iOS kind:uptime' }).queries[0].query).toBe(
      'kind:uptime',
    )
    // Distinct users from the events
    const users = await widgetData(
      db,
      v2({ queries: [{ query: '', aggregate: 'count_unique(user)' }] }),
      undefined,
      window,
      NOW,
    )
    expect(users).toMatchObject({ kind: 'number', values: [{ value: 2 }] })
  })

  it('charts avg and p95 of a numeric log attribute, two queries in one chart', async () => {
    const db = seeded()
    const w = v2({
      dataset: 'logs',
      display: 'line',
      queries: [
        { query: '', aggregate: 'avg(duration)' },
        { query: '', aggregate: 'p95(duration)' },
      ],
    })
    const data = await widgetData(db, w, undefined, window, NOW)
    if (data.kind !== 'series') throw new Error(JSON.stringify(data))
    expect(data.units).toEqual(['ms', 'ms'])
    const last = (i: number) => data.series.find((s) => s.query === i)!.counts.filter((v) => v !== null)
    // 10…100 and 1000, the log without one left out: nearest-rank p95 of 11 values is the 11th
    expect(last(0)).toEqual([1550 / 11])
    expect(last(1)).toEqual([1000])
    const number = await widgetData(
      db,
      { ...w, display: 'number', queries: [{ query: 'route:/a', aggregate: 'p50(duration)' }] },
      undefined,
      window,
      NOW,
    )
    expect(number).toMatchObject({ values: [{ value: 50 }] })
  })

  it('groups by two fields', async () => {
    const db = seeded()
    const data = await widgetData(
      db,
      v2({ display: 'table', groupBy: ['release', 'environment'] }),
      undefined,
      window,
      NOW,
    )
    expect(data).toMatchObject({
      kind: 'table',
      fields: ['release', 'environment'],
      rows: [
        { group: ['1.1', 'production'], values: [2] },
        { group: ['1.1', 'staging'], values: [4] },
        { group: ['1.0', 'production'], values: [3] },
      ].sort((a, b) => b.values[0] - a.values[0]),
    })
    const logs = await widgetData(
      db,
      v2({
        dataset: 'logs',
        display: 'table',
        groupBy: ['level', 'route'],
        queries: [{ query: '', aggregate: 'max(duration)' }],
      }),
      undefined,
      window,
      NOW,
    )
    expect(logs).toMatchObject({
      rows: [
        { group: ['error', '/b'], values: [1000] },
        { group: ['info', '/a'], values: [100] },
      ],
    })
  })

  it('takes a transactions p95 from its histogram, as the performance pages do', async () => {
    const db = seeded()
    const durations = [120, 130, 150, 400, 900, 2500]
    for (const [i, d] of durations.entries())
      db.sqlite.exec(`INSERT INTO transaction_buckets (project_id, name, release, hour, bucket, count)
        VALUES (1, '/checkout', '1.0', ${NOW - (i % 2 ? 1 : 2) * HOUR}, ${bucketOf(d)}, 1)
        ON CONFLICT DO UPDATE SET count = count + 1`)
    const expected = percentile(new Map([...Map.groupBy(durations, bucketOf)].map(([b, ds]) => [b, ds.length])), 0.95)
    const data = await widgetData(
      db,
      v2({ dataset: 'transactions', queries: [{ query: 'transaction:/checkout', aggregate: 'p95(duration)' }] }),
      undefined,
      window,
      NOW,
    )
    expect(data).toMatchObject({ kind: 'number', values: [{ value: expected, unit: 'ms' }] })
    expect(expected).toBeGreaterThan(2000)
  })

  it('reads crash-free sessions per release', async () => {
    const db = seeded()
    db.sqlite.exec(`INSERT INTO sessions_daily (project_id, release, environment, day, started, crashed) VALUES
      (1, '1.0', 'production', '2026-10-26', 200, 4), (1, '1.1', 'production', '2026-10-26', 100, 0),
      (1, '1.0', 'production', '2026-10-25', 100, 2), (1, '0.9', 'production', '2026-09-01', 100, 50)`)
    const data = await widgetData(
      db,
      v2({ dataset: 'releases', display: 'table', queries: [{ query: '', aggregate: 'crash_free_rate' }] }),
      undefined,
      window,
      NOW,
    )
    expect(data).toMatchObject({
      kind: 'table',
      fields: ['release'],
      units: ['percent'],
      rows: [
        { group: ['1.1'], values: [100] },
        { group: ['1.0'], values: [98] },
      ],
    })
  })

  it('reads crash-free users and a vital’s p75', async () => {
    const db = seeded()
    db.sqlite.exec(`INSERT INTO session_users_daily (project_id, release, environment, day, did_hash, crashed) VALUES
      (1, '1.0', 'production', '2026-10-26', 'a', 0), (1, '1.0', 'production', '2026-10-26', 'b', 1),
      (1, '1.0', 'production', '2026-10-25', 'b', 0), (1, '1.0', 'production', '2026-10-25', 'c', 0),
      (1, '1.0', 'production', '2026-10-25', 'd', 0);
      INSERT INTO vital_buckets (project_id, name, release, hour, vital, bucket, count) VALUES
      (1, '/', '1.0', ${NOW - HOUR}, 'cls', 26, 3), (1, '/', '1.0', ${NOW - HOUR}, 'lcp', 40, 9)`)
    const users = await widgetData(
      db,
      v2({ dataset: 'sessions', queries: [{ query: '', aggregate: 'crash_free_users' }] }),
      undefined,
      { range: '7d' },
      NOW,
    )
    // Four users, one crashed: a user counts once however many days
    expect(users).toMatchObject({ kind: 'number', values: [{ value: 75, unit: 'percent' }] })
    const cls = await widgetData(
      db,
      v2({ dataset: 'transactions', queries: [{ query: '', aggregate: 'p75(cls)' }] }),
      undefined,
      window,
      NOW,
    )
    expect(cls).toMatchObject({ kind: 'number', values: [{ value: Math.round(1.2 ** 26) / 1000, unit: 'number' }] })
    expect(aggregateError('transactions', 'avg(lcp)')).toBe('A vital can show p50, p75, p95 or p99, such as p75(lcp).')
  })

  it('reads monitors’ uptime and check-ins by status', async () => {
    const db = seeded()
    db.sqlite.exec(`
      INSERT INTO monitors (id, project_id, slug, name, kind, config, created_at) VALUES (1, 1, 'home', 'Home', 'uptime', '{}', 0),
        (2, 1, 'backup', 'Backup', 'cron', '{}', 0);
      INSERT INTO uptime_results (monitor_id, at, ok, status, ms) VALUES (1, ${NOW - HOUR}, 1, 200, 100),
        (1, ${NOW - 2 * HOUR}, 1, 200, 120), (1, ${NOW - 3 * HOUR}, 1, 200, 140), (1, ${NOW - 4 * HOUR}, 0, 500, 900);
      INSERT INTO check_ins (id, monitor_id, status, started) VALUES ('a', 2, 'ok', ${NOW - HOUR}),
        ('b', 2, 'error', ${NOW - 2 * HOUR}), ('c', 2, 'missed', ${NOW - 3 * HOUR}), ('d', 2, 'ok', ${NOW - 4 * HOUR}),
        ('e', 2, 'in_progress', ${NOW - 60e3});`)
    const uptime = await widgetData(
      db,
      v2({ dataset: 'monitors', queries: [{ query: 'kind:uptime', aggregate: 'uptime' }] }),
      undefined,
      window,
      NOW,
    )
    expect(uptime).toMatchObject({ values: [{ value: 75, unit: 'percent' }] })
    const statuses = await widgetData(
      db,
      v2({
        dataset: 'monitors',
        display: 'table',
        groupBy: ['status'],
        queries: [{ query: 'kind:cron', aggregate: 'count' }],
      }),
      undefined,
      window,
      NOW,
    )
    expect(statuses).toMatchObject({
      rows: [
        { group: ['ok'], values: [2] },
        { group: ['error'], values: [1] },
        { group: ['missed'], values: [1] },
      ],
    })
  })

  it('shows markdown as its text', async () => {
    const db = seeded()
    expect(
      await widgetData(
        db,
        v2({ dataset: 'markdown', display: 'text', queries: [], text: 'Hi' }),
        undefined,
        window,
        NOW,
      ),
    ).toEqual({ kind: 'text', text: 'Hi' })
    // min and max need each row: transactions are kept per hour
    expect(
      await widgetData(
        db,
        v2({ dataset: 'monitors', queries: [{ query: 'kind:', aggregate: 'count' }] }),
        undefined,
        window,
        NOW,
      ),
    ).toMatchObject({ kind: 'number' })
  })
})
