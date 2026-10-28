import { describe, expect, it } from 'vitest'
import { memoryR2, sqliteD1 } from '../../test/fakes'
import { pruneLogs } from './logs'
import { deleteProject, pruneEvents } from './projects'

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
      INSERT INTO session_crashes (project_id, sid, at) VALUES (1, 'old', ${NOW - 3 * DAY}), (1, 'new', ${NOW - DAY});
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
      sessionCrashes: 1,
    })
    expect(await pruneLogs(db, NOW, deadline)).toEqual({ logs: 12000 })
    expect(Date.now() - started).toBeLessThan(20_000)

    expect([count('events'), count('logs'), count('attachments'), count('issues')]).toEqual([1, 1, 1, 1])
    expect([count('issue_days'), count('issue_tag_values'), count('issue_activity')]).toEqual([1, 0, 0])
    expect([count('issue_minutes'), count('session_users_daily'), count('session_crashes')]).toEqual([1, 1, 1])
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
      sessionCrashes: 0,
    })
  })
})

describe('deleting a project', () => {
  it('takes its rows in batches and its files in R2, and goes on from where a run out of time stopped', async () => {
    const db = sqliteD1()
    const files = memoryR2()
    db.sqlite.exec(`
      INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'Big', 'k', 0), (2, 'b', 'Kept', 'k2', 0);
      INSERT INTO issues (id, project_id, fingerprint, title, first_seen, last_seen, count) VALUES (1, 1, 'f', 'I', 0, 0, 1);
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500)
        INSERT INTO logs (project_id, timestamp, received, level, body, attributes) SELECT 1, 0, 0, 'info', 'x', '{}' FROM n;
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500)
        INSERT INTO events (id, project_id, issue_id, timestamp, received, level, platform, data)
        SELECT printf('%032x', i), 1, 1, 0, 0, 'error', 'node', '{}' FROM n;
      INSERT INTO logs (project_id, timestamp, received, level, body, attributes) VALUES (2, 0, 0, 'info', 'kept', '{}');
    `)
    await files.put('attachments/1/e/0-shot.png', 'x')
    await files.put('envelopes/1/2026-10-28/e', 'x')
    await files.put('attachments/2/e/0-shot.png', 'x')
    await expect(deleteProject(db, files, 1, Date.now() - 1)).rejects.toThrow('Delete it again to go on')
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 2 })
    await deleteProject(db, files, 1)
    const count = (sql: string) => (db.sqlite.prepare(sql).get() as { n: number }).n
    expect([count('SELECT COUNT(*) AS n FROM projects'), count('SELECT COUNT(*) AS n FROM logs')]).toEqual([1, 1])
    expect(count('SELECT COUNT(*) AS n FROM events')).toBe(0)
    expect([...files.objects.keys()]).toEqual(['attachments/2/e/0-shot.png'])
  })
})
