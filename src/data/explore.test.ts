import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { eventFilter } from '../search/query'
import { exploreChart, exploreEvents, traceOf, whereOf } from './explore'

const NOW = Date.UTC(2026, 9, 26, 12)
const HOUR = 36e5

function seeded() {
  const db = sqliteD1()
  db.sqlite.exec(`
    INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'app', 'App', 'k1', 0), (2, 'web', 'Web', 'k2', 0);
    INSERT INTO issues (id, project_id, fingerprint, title, culprit, type, level, platform, status, first_seen, last_seen) VALUES
      (1, 1, 'a', 'TypeError: x is undefined', '', 'error', 'error', 'cocoa', 'unresolved', 0, 0),
      (2, 2, 'b', 'Timeout', '', 'error', 'warning', 'javascript', 'resolved', 0, 0);
    INSERT INTO events (id, project_id, issue_id, timestamp, received, level, platform, release, environment, message, data, user_hash, trace_id) VALUES
      ('e1', 1, 1, 0, ${NOW - HOUR}, 'error', 'cocoa', '1.0', 'production', 'TypeError: x is undefined', '{}', 'u1', 't1'),
      ('e2', 1, 1, 0, ${NOW - 2 * HOUR}, 'error', 'cocoa', '1.1', 'production', 'TypeError: x is undefined', '{}', 'u1', NULL),
      ('e3', 1, 1, 0, ${NOW - 3 * HOUR}, 'error', 'cocoa', '1.1', 'staging', 'TypeError: x is undefined', '{}', 'u2', NULL),
      ('e4', 2, 2, 0, ${NOW - HOUR}, 'warning', 'javascript', '2.0', 'production', 'Timeout', '{}', 'u3', 't1'),
      ('e5', 2, 2, 0, ${NOW - 40 * 864e5}, 'warning', 'javascript', '2.0', 'production', 'Timeout', '{}', 'u3', NULL);
    INSERT INTO event_tags (event_id, project_id, key, value) VALUES
      ('e1', 1, 'device', 'iPad13,1'), ('e2', 1, 'device', 'iPhone15,2'), ('e3', 1, 'device', 'iPad8,1'),
      ('e4', 2, 'browser', 'Chrome 130'), ('e1', 1, 'song', 'it''s 100% done');
    INSERT INTO logs (id, project_id, timestamp, received, level, body, attributes, trace_id) VALUES
      (1, 1, ${NOW - HOUR}, 0, 'info', 'Syncing', '{}', 't1');
    INSERT INTO transaction_examples (id, project_id, name, release, day, timestamp, duration, trace_id, spans) VALUES
      ('x1', 1, 'GET /songs', '1.0', '2026-10-26', ${NOW - HOUR}, 420, 't1', '[{"op":"db","description":"SELECT","start":0,"duration":10,"depth":0}]');
  `)
  return db
}

describe('explore', () => {
  it('searches events by their columns, tags and words, every value bound', async () => {
    const db = seeded()
    const ids = async (query: string, extra = {}) =>
      (await exploreEvents(db, { query, range: '24h', ...extra }, NOW)).rows.map((r) => r.id)
    expect(await ids('')).toEqual(['e1', 'e4', 'e2', 'e3'])
    expect(await ids('device:iPad*')).toEqual(['e1', 'e3'])
    expect(await ids('!device:iPad* project:app')).toEqual(['e2'])
    expect(await ids('release:1.1 environment:staging')).toEqual(['e3'])
    expect(await ids('level:warning')).toEqual(['e4'])
    expect(await ids('timeout')).toEqual(['e4'])
    expect(await ids('is:resolved')).toEqual(['e4'])
    expect(await ids('trace:t1')).toEqual(['e1', 'e4'])
    expect(await ids('has:browser')).toEqual(['e4'])
    expect(await ids(`song:"it's 100% done"`)).toEqual(['e1'])
    expect(await ids('', { range: '30d', issueId: 2 })).toEqual(['e4'])
    expect(await ids('', { projectId: 1 })).toEqual(['e1', 'e2', 'e3'])
    // No value is ever in the SQL itself
    const where = whereOf({ query: `device:"x' OR 1=1 --" "drop table" issue:2`, range: '24h' }, NOW)
    expect(where.sql).not.toMatch(/OR 1=1|drop table/)
    expect(where.params).toContain("x' OR 1=1 --")
    expect(eventFilter('issue:abc', NOW).where).toEqual([])
  })

  it('shows the columns asked for, tags among them, and pages older', async () => {
    const db = seeded()
    const out = await exploreEvents(db, { query: 'project:app', range: '24h', columns: ['device', 'release'] }, NOW)
    expect(out.columns).toEqual(['device', 'release'])
    expect(out.rows[0]).toMatchObject({
      id: 'e1',
      issue_id: 1,
      title: 'TypeError: x is undefined',
      values: ['iPad13,1', '1.0'],
    })
    expect(out.older).toBeNull()
  })

  it('pages through events that came in the same millisecond without skipping any', async () => {
    const db = seeded()
    // 120 events, three to a millisecond: a page of 50 would end inside one
    db.sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 119)
      INSERT INTO events (id, project_id, issue_id, timestamp, received, level, platform, data)
      SELECT 'b' || i, 1, 1, 0, ${NOW - 5 * HOUR} - i / 3, 'error', 'cocoa', '{}' FROM n`)
    const seen: string[] = []
    let before: number | undefined
    do {
      const page = await exploreEvents(db, { query: '', range: '24h', projectId: 1, before }, NOW)
      seen.push(...page.rows.map((r) => r.id))
      before = page.older ?? undefined
    } while (before !== undefined)
    expect(seen.filter((id) => id.startsWith('b')).sort()).toEqual(
      Array.from({ length: 120 }, (_, i) => `b${i}`).sort(),
    )
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('charts a count or users over time, and groups by a tag or a column', async () => {
    const db = seeded()
    const all = await exploreChart(db, { query: '', range: '24h' }, NOW)
    expect(all.interval).toBe('1h')
    expect(all.series[0].values.reduce((a, b) => a + b, 0)).toBe(4)
    const users = await exploreChart(db, { query: 'project:app', range: '24h', aggregate: 'count_unique(user)' }, NOW)
    expect(users.series[0].values.reduce((a, b) => a + b, 0)).toBe(3) // u1 in two hours, u2 in one
    const byDevice = await exploreChart(db, { query: '', range: '24h', groupBy: 'device' }, NOW)
    expect(byDevice.groups).toEqual([
      { value: 'iPad13,1', v: 1 },
      { value: 'iPad8,1', v: 1 },
      { value: 'iPhone15,2', v: 1 },
    ])
    const byRelease = await exploreChart(db, { query: '', range: '24h', groupBy: 'release' }, NOW)
    expect(byRelease.groups[0]).toEqual({ value: '1.1', v: 2 })
    expect(byRelease.series.find((s) => s.key === '1.1')!.values.reduce((a, b) => a + b, 0)).toBe(2)
  })

  it('gathers a trace: its events with their issues, its logs and its stored transactions', async () => {
    const t = await traceOf(seeded(), 't1')
    expect(t.events.map((e) => [e.id, e.title, e.project])).toEqual([
      ['e1', 'TypeError: x is undefined', 'app'],
      ['e4', 'Timeout', 'web'],
    ])
    expect(t.logs.map((l) => l.body)).toEqual(['Syncing'])
    expect(t.transactions[0]).toMatchObject({ name: 'GET /songs', duration: 420, spans: [{ op: 'db' }] })
  })
})
