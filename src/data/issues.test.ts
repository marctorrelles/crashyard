import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { normalizeEvent } from '../ingest/event'
import { HASHERS } from '../ingest/grouping'
import { storeEvent } from '../ingest/store'
import { attachmentType, mergedFingerprints, mergeIssues, unmergeIssue } from './issues'

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
