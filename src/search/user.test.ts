import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { eventFilter, issueFilter } from './query'
import { hashUser, userKeysOf, userMatch } from './user'

const NOW = Date.UTC(2026, 9, 27)

// Issue 1 has an event from before 0021 (the id's hash only), issue 2 one with every field
function seeded() {
  const db = sqliteD1()
  const keys = userKeysOf({
    id: 'u-7',
    email: 'Ana@Example.com ',
    username: 'ana',
    name: 'Ana Pons',
    ip_address: '1.2.3.4',
  })
  db.sqlite.exec(`
    INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'app', 'App', 'k1', 0);
    INSERT INTO issues (id, project_id, fingerprint, title, culprit, type, level, platform, status, first_seen, last_seen) VALUES
      (1, 1, 'a', 'Old', '', 'error', 'error', 'cocoa', 'unresolved', 0, 0),
      (2, 1, 'b', 'New', '', 'error', 'error', 'cocoa', 'unresolved', 0, 0);
    INSERT INTO events (id, project_id, issue_id, timestamp, received, level, platform, data, user_hash, user_keys) VALUES
      ('e1', 1, 1, 0, ${NOW}, 'error', 'cocoa', '{}', '${hashUser('old-id')}', NULL),
      ('e2', 1, 2, 0, ${NOW}, 'error', 'cocoa', '{}', '${hashUser('u-7')}', '${keys}');
    INSERT INTO issue_users (issue_id, user_hash) VALUES (1, '${hashUser('old-id')}'), (2, '${hashUser('u-7')}');
  `)
  return db
}

describe('user search', () => {
  it('hashes as ingest always has, so users stored before still match', async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('user-42'))
    const before = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32)
    expect(hashUser('user-42')).toBe(before)
  })

  it('keeps a hash per field, never the IP address, and nothing for no user', () => {
    expect(userKeysOf({ id: 7, email: '', ip_address: '1.2.3.4' })).toBe(userMatch('user.id', '7').keys[0])
    expect(userKeysOf({ ip_address: '1.2.3.4' })).toBeUndefined()
  })

  it('finds one person’s issues and events by any field, or by the field named', async () => {
    const db = seeded()
    const issues = async (query: string) => {
      const f = issueFilter(query, NOW, undefined, userMatch)
      const rows = await db
        .prepare(`SELECT i.id FROM issues i WHERE ${f.where.join(' AND ') || '1'} ORDER BY i.id`)
        .bind(...f.params)
        .all<{ id: number }>()
      return rows.results.map((r) => r.id)
    }
    expect(await issues('user:old-id')).toEqual([1])
    expect(await issues('user:u-7')).toEqual([2])
    expect(await issues('user:ana@example.com')).toEqual([2])
    expect(await issues('user.email:ANA@example.com')).toEqual([2])
    expect(await issues('user.username:ana')).toEqual([2])
    expect(await issues('user.name:"Ana Pons"')).toEqual([2])
    expect(await issues('user.id:ana')).toEqual([])
    expect(await issues('user:1.2.3.4')).toEqual([])
    expect(await issues('user:[old-id,ana]')).toEqual([1, 2])
    expect(await issues('!user:ana')).toEqual([1])

    const events = async (query: string) => {
      const f = eventFilter(query, NOW, userMatch)
      const rows = await db
        .prepare(`SELECT e.id FROM events e WHERE ${f.where.join(' AND ')} ORDER BY e.id`)
        .bind(...f.params)
        .all<{ id: string }>()
      return rows.results.map((r) => r.id)
    }
    expect(await events('user:ana@example.com')).toEqual(['e2'])
    expect(await events('user:old-id')).toEqual(['e1'])
    expect(await events('!user.username:ana')).toEqual(['e1'])
    // Without the matcher, as in the browser, nobody matches
    expect(issueFilter('user:u-7', NOW).params).toEqual(['none', 'none'])
  })
})
