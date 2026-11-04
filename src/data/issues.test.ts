import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { normalizeEvent } from '../ingest/event'
import { HASHERS } from '../ingest/grouping'
import { NO_RULES } from '../ingest/rules'
import { storeEvent } from '../ingest/store'
import {
  assignees,
  assignIssue,
  attachmentType,
  bookmarkIssue,
  changeIssues,
  listIssues,
  markViewed,
  mergedFingerprints,
  mergeIssues,
  unmergeIssue,
} from './issues'

describe('attachments', () => {
  it('shows png, jpeg, gif and webp as images, and nothing else', () => {
    expect(attachmentType('screenshot.png', 'image/png')).toBe('image/png')
    expect(attachmentType('photo.JPG', null)).toBe('image/jpeg')
    expect(attachmentType('a.bin', 'image/webp')).toBe('image/webp')
    for (const [name, type] of [
      ['logo.svg', 'image/svg+xml'],
      ['page.html', 'text/html'],
      ['view-hierarchy.json', 'application/json'],
      ['trick.svg', 'image/png;x'],
    ])
      expect(attachmentType(name, type), name).toBeNull()
  })
})

describe('many issues at once', () => {
  // D1 binds 100 values a statement at most: a page of 50 picked, or an agent's 100, go as one JSON value
  const seeded = (n: number) => {
    const db = sqliteD1()
    db.sqlite.exec(`INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'k', 0);
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n})
        INSERT INTO issues (id, project_id, fingerprint, title, first_seen, last_seen, count, last_release)
        SELECT i, 1, 'f' || i, 'Issue ' || i, i, i, 1, '1.' || i FROM n;`)
    return { db, ids: Array.from({ length: n }, (_, i) => i + 1) }
  }
  const one = (db: ReturnType<typeof sqliteD1>, sql: string) => db.sqlite.prepare(sql).get()

  it('merges 40 issues into one', async () => {
    const { db, ids } = seeded(40)
    await mergeIssues(db, ids, 'me', 0)
    expect(one(db, 'SELECT COUNT(*) AS n, MAX(count) AS count FROM issues')).toEqual({ n: 1, count: 40 })
    expect(one(db, 'SELECT COUNT(*) AS n FROM issue_fingerprints')).toEqual({ n: 39 })
  })

  it('resolves 120 issues in their current release, and deletes and discards 120', async () => {
    const { db, ids } = seeded(120)
    await changeIssues(db, ids, { action: 'resolve', current: true }, 'me', 0)
    expect(
      one(db, "SELECT COUNT(*) AS n FROM issues WHERE status = 'resolved' AND fixed_in_release = last_release"),
    ).toEqual({
      n: 120,
    })
    await changeIssues(db, ids, { action: 'delete', discard: true }, 'me', 0)
    expect(one(db, 'SELECT COUNT(*) AS n FROM issues')).toEqual({ n: 0 })
    expect(one(db, 'SELECT COUNT(*) AS n FROM discarded_fingerprints')).toEqual({ n: 120 })
  })
})

describe('unmerge', () => {
  it('moves a merged fingerprint’s events, days, hours, tags and users back to an issue of its own', async () => {
    const db = sqliteD1()
    db.sqlite.exec("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'k', 0)")
    const project = {
      id: 1,
      slug: 'a',
      name: 'a',
      daily_event_quota: 1e6,
      daily_log_quota: 1e6,
      daily_transaction_quota: 1e6,
    }
    const DAY = 86_400_000
    const send = async (fingerprint: string, n: number, raw: Record<string, unknown>) => {
      const e = await normalizeEvent({ ...raw, user: { id: `u${n}` }, tags: { song: `s${n % 2}` } }, DAY * (n + 1))
      return (await storeEvent(db, project, { ...e, id: String(n).padStart(32, '0') }, fingerprint))!.issue.id
    }
    const a = await send('fa', 1, { message: 'Crash A' })
    await send('fa', 2, { message: 'Crash A' })
    const b = await send('fb', 3, { message: 'Crash B', release: '2.0' })
    await send('fb', 4, { message: 'Crash B', release: '2.0' })
    // An event stored before 0016 has no fingerprint: it's hashed from its JSON when unmerging
    db.sqlite.exec("UPDATE events SET fingerprint = NULL WHERE id = '00000000000000000000000000000004'")
    const legacy = await HASHERS[1](
      JSON.parse((db.sqlite.prepare("SELECT data FROM events WHERE id LIKE '%4'").get() as { data: string }).data),
      NO_RULES,
    )
    db.sqlite.exec(
      `UPDATE issues SET fingerprint = '${legacy}' WHERE id = ${b}; UPDATE events SET fingerprint = '${legacy}' WHERE id LIKE '%3'`,
    )
    await mergeIssues(db, [a, b], 'me', 0)
    expect(await mergedFingerprints(db, a)).toMatchObject([{ fingerprint: legacy, events: 2, title: 'Crash B' }])

    const made = (await unmergeIssue(db, a, legacy, 'me', 10))!
    const issue = (id: number) =>
      db.sqlite.prepare('SELECT count, user_count, first_release, fingerprint FROM issues WHERE id = ?').get(id)
    expect(issue(made)).toEqual({ count: 2, user_count: 2, first_release: '2.0', fingerprint: legacy })
    expect(issue(a)).toMatchObject({ count: 2, user_count: 2 })
    const days = (id: number) =>
      db.sqlite.prepare('SELECT day, count FROM issue_days WHERE issue_id = ? ORDER BY day').all(id)
    expect(days(a)).toEqual([
      { day: '1970-01-03', count: 1 },
      { day: '1970-01-04', count: 1 },
    ])
    expect(days(made)).toHaveLength(2)
    const hours = (id: number) =>
      db.sqlite.prepare('SELECT SUM(count) AS n FROM event_hours WHERE issue_id = ?').get(id)
    expect([hours(a), hours(made)]).toEqual([{ n: 2 }, { n: 2 }])
    const tags = (id: number) =>
      db.sqlite
        .prepare("SELECT value, count FROM issue_tag_values WHERE issue_id = ? AND key = 'song' ORDER BY value")
        .all(id)
    expect(tags(made)).toEqual([
      { value: 's0', count: 1 },
      { value: 's1', count: 1 },
    ])
    expect(tags(a)).toEqual(tags(made))
    // New events of that fingerprint go to the new issue now
    expect(await mergedFingerprints(db, a)).toEqual([])
    expect(await send(legacy, 5, { message: 'Crash B' })).toBe(made)
  })
})

describe('assignment, bookmarks and unread', () => {
  it('search by assignee, bookmark and what has events since it was opened', async () => {
    const db = sqliteD1()
    db.sqlite.exec(`INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'k', 0);
      INSERT INTO issues (id, project_id, fingerprint, title, first_seen, last_seen) VALUES
        (1, 1, 'a', 'One', 0, 100), (2, 1, 'b', 'Two', 0, 100), (3, 1, 'c', 'Three', 0, 100)`)
    await assignIssue(db, 1, 'me@x.com', 'me@x.com', 1)
    await assignIssue(db, 2, 'ada@x.com', 'me@x.com', 1)
    await bookmarkIssue(db, 'me@x.com', 3, true)
    await markViewed(db, 'me@x.com', 1, 200)
    await markViewed(db, 'me@x.com', 2, 50) // before its last event: still unread
    const ids = async (query: string, viewer = 'me@x.com') =>
      (await listIssues(db, { query, sort: 'lastSeen', page: 0, viewer }, 1000)).issues.map((i) => i.id).sort()
    expect(await ids('assigned:me')).toEqual([1])
    expect(await ids('assigned:ada@x.com')).toEqual([2])
    expect(await ids('is:assigned')).toEqual([1, 2])
    expect(await ids('is:unassigned')).toEqual([3])
    expect(await ids('is:bookmarked')).toEqual([3])
    expect(await ids('is:unread')).toEqual([2, 3])
    expect(await ids('is:unread', 'ada@x.com')).toEqual([1, 2, 3])
    const rows = (await listIssues(db, { query: '', sort: 'lastSeen', page: 0, viewer: 'me@x.com' }, 1000)).issues
    expect(rows.find((i) => i.id === 3)).toMatchObject({ bookmarked: 1, unread: 1 })
    expect(rows.find((i) => i.id === 1)).toMatchObject({ bookmarked: 0, unread: 0, assignee: 'me@x.com' })
    expect(await assignees(db, 'me@x.com')).toEqual(['me@x.com', 'ada@x.com'])
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM issue_activity WHERE kind = 'assigned'").get()).toEqual({
      n: 2,
    })
  })
})
