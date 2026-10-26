import { describe, expect, it } from 'vitest'
import { memoryR2, sqliteD1 } from '../../test/fakes'
import { BACKLOG_CAP, health, usage } from './health'
import { setSetting } from './settings'

const DAY = 864e5
const NOW = Date.UTC(2026, 9, 26, 12)

function seeded() {
  const db = sqliteD1()
  db.sqlite.exec(`
    INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'ka', 0), (2, 'b', 'b', 'kb', 0);
    INSERT INTO project_days (project_id, day, events, logs, transactions, dropped, filtered, failed) VALUES
      (1, '2026-10-26', 5, 50, 2, 1, 3, 1), (2, '2026-10-26', 1, 0, 0, 0, 0, 0), (1, '2026-10-25', 7, 0, 0, 0, 0, 0),
      (1, '2026-09-01', 100, 0, 0, 0, 0, 0);
  `)
  return db
}

describe('usage', () => {
  it('sums each day of every project, or of one, oldest first with zeros where none', async () => {
    const db = seeded()
    const all = await usage(db, undefined, 30, NOW)
    expect(all.days).toHaveLength(30)
    expect(all.days.at(-1)).toBe('2026-10-26')
    expect(all.events.slice(-2)).toEqual([7, 6])
    expect(all.events.reduce((a, b) => a + b, 0)).toBe(13) // September's 100 is past the 30 days
    expect({ dropped: all.dropped.at(-1), filtered: all.filtered.at(-1), failed: all.failed.at(-1) }).toEqual({
      dropped: 1,
      filtered: 3,
      failed: 1,
    })
    expect((await usage(db, 2, 30, NOW)).events.slice(-2)).toEqual([0, 1])
  })
})

describe('health', () => {
  it('reports files, the cron, failed notifications, envelopes and what retention has still to prune', async () => {
    const db = seeded()
    const files = memoryR2()
    const old = NOW - 100 * DAY
    db.sqlite.exec(`
      INSERT INTO debug_files (project_id, checksum, name, debug_id, kind, file_key, size, created_at)
        VALUES (1, 'c', 'n', 'd', 'macho', 'f', 1000, 0);
      INSERT INTO attachments (event_id, project_id, filename, size, r2_key, received) VALUES ('e', 1, 'a.png', 20, 'k', ${NOW});
      INSERT INTO issues (id, project_id, fingerprint, title, first_seen, last_seen) VALUES (1, 1, 'f', 'T', ${old}, ${old});
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${BACKLOG_CAP + 5})
        INSERT INTO events (id, project_id, issue_id, timestamp, received, level, platform, data)
        SELECT printf('%032x', i), 1, 1, ${old}, ${old}, 'error', 'node', '{}' FROM n;
      INSERT INTO logs (project_id, timestamp, received, level, body, attributes) VALUES (1, ${old}, ${old}, 'info', 'x', '{}');
      INSERT INTO channels (id, kind, name, config, created_at) VALUES (1, 'webhook', 'Hook', '{}', 0);
      INSERT INTO notification_failures (channel_id, kind, error, at) VALUES
        (1, 'new', 'refused', ${NOW - DAY}), (9, 'new', 'gone', ${NOW - 2 * DAY}), (1, 'new', 'old', ${NOW - 8 * DAY});
    `)
    await files.put('pending/1/1-a', 'x')
    await files.put('failed/1/1-b', 'x')
    await files.put('failed/2/1-c', 'x')
    const late = await health({ DB: db, FILES: files }, NOW)
    expect(late.cron).toEqual({ lastRun: null, late: true })
    expect(late.files).toEqual({ debugFiles: 1000, bundles: 0, attachments: 20 })
    expect(late.notifications.failed).toBe(2)
    expect(late.notifications.recent.map((f) => f.channel)).toEqual(['Hook', null])
    expect(late.envelopes).toEqual({ pending: { count: 1, more: false }, failed: { count: 2, more: false } })
    expect(late.backlog).toEqual({ events: BACKLOG_CAP, logs: 1 })
    await setSetting(db, 'cron.last_run', NOW - 60_000, null)
    expect((await health({ DB: db, FILES: files }, NOW)).cron).toEqual({ lastRun: NOW - 60_000, late: false })
    expect((await health({ DB: db, FILES: files }, NOW + 3 * 60_000)).cron.late).toBe(true)
  })
})
