import { describe, expect, it } from 'vitest'
import { memoryR2, sqliteD1 } from '../../test/fakes'
import { pruneLogs } from './logs'
import { pruneEvents } from './projects'

const DAY = 864e5
const NOW = Date.UTC(2026, 9, 26, 12)

describe('retention', () => {
  it('prunes 12,000 old events and 12,000 old logs in one run, with old issues and attachments, and keeps the rest', async () => {
    const db = sqliteD1()
    const files = memoryR2()
    const old = NOW - 100 * DAY // past the default 90 days of events and 30 of logs
    db.sqlite.exec(`
      INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'k', 0);
      INSERT INTO issues (id, project_id, fingerprint, title, first_seen, last_seen, count) VALUES
        (1, 1, 'old', 'Old', ${old}, ${old}, 12000), (2, 1, 'new', 'New', ${old}, ${NOW}, 1);
      INSERT INTO issue_days (issue_id, day, count) VALUES (1, '2026-07-18', 12000), (2, '2026-10-26', 1);
      INSERT INTO issue_tag_values (issue_id, key, value, count, last_seen) VALUES (1, 'os', 'iOS', 1, ${old});
      INSERT INTO issue_activity (issue_id, kind, at) VALUES (1, 'created', ${old});
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12000)
        INSERT INTO events (id, project_id, issue_id, timestamp, received, level, platform, data)
        SELECT printf('%032x', i), 1, 1, ${old}, ${old}, 'error', 'node', '{}' FROM n;
      INSERT INTO events (id, project_id, issue_id, timestamp, received, level, platform, data)
        VALUES ('${'f'.repeat(32)}', 1, 2, ${NOW}, ${NOW}, 'error', 'node', '{}');
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12000)
        INSERT INTO logs (project_id, timestamp, received, level, body, attributes)
        SELECT 1, ${old}, ${old}, 'info', 'old', '{}' FROM n;
      INSERT INTO logs (project_id, timestamp, received, level, body, attributes) VALUES (1, ${NOW}, ${NOW}, 'info', 'new', '{}');
      INSERT INTO attachments (event_id, project_id, filename, size, r2_key, received) VALUES
        ('${'0'.repeat(31)}1', 1, 'old.png', 1, 'attachments/1/old.png', ${old}),
        ('${'f'.repeat(32)}', 1, 'new.png', 1, 'attachments/1/new.png', ${NOW});
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 199)
        INSERT INTO attachments (event_id, project_id, filename, size, r2_key, received)
        SELECT printf('%032x', i + 1), 1, 'old.png', 1, printf('attachments/1/%d.png', i), ${old} FROM n;
      INSERT INTO issue_minutes (issue_id, minute, count) VALUES
        (2, ${Math.floor((NOW - 2 * DAY) / 60_000)}, 3), (2, ${Math.floor(NOW / 60_000)}, 1);
      INSERT INTO session_users_daily (project_id, release, environment, day, did_hash) VALUES
        (1, '1.0', 'production', '2026-07-18', 'a'), (1, '1.0', 'production', '2026-10-26', 'a');
    `)
    await files.put('attachments/1/old.png', 'x')
    await files.put('attachments/1/new.png', 'x')
    const count = (table: string) => (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

    const started = Date.now()
    const deadline = started + 20_000
    expect(await pruneEvents(db, NOW, files, deadline)).toEqual({
      events: 12000,
      attachments: 200,
      issues: 1,
      hours: 0,
      minutes: 1,
      sessionUsers: 1,
    })
    expect(await pruneLogs(db, NOW, deadline)).toEqual({ logs: 12000 })
    expect(Date.now() - started).toBeLessThan(20_000)

    expect([count('events'), count('logs'), count('attachments'), count('issues')]).toEqual([1, 1, 1, 1])
    expect([count('issue_days'), count('issue_tag_values'), count('issue_activity')]).toEqual([1, 0, 0])
    expect([count('issue_minutes'), count('session_users_daily')]).toEqual([1, 1])
    expect([...files.objects.keys()]).toEqual(['attachments/1/new.png'])
  })

  it('stops at the deadline', async () => {
    const db = sqliteD1()
    db.sqlite.exec("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'k', 0)")
    expect(await pruneEvents(db, NOW, undefined, Date.now() - 1)).toEqual({
      events: 0,
      attachments: 0,
      issues: 0,
      hours: 0,
      minutes: 0,
      sessionUsers: 0,
    })
  })
})
