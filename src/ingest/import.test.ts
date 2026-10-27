import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { normalizeEvent } from './event'
import { importPage, nextCursor } from './import'
import { groupingFor, type Project, storeEvent } from './store'

const fixture = (name: string) => JSON.parse(readFileSync(`test/fixtures/events/${name}.json`, 'utf8'))
const source = { base: 'https://sentry.example', token: 't', org: 'acme', project: 'shop' }

// Sentry as the import asks it: two issues on the first page, none on the next; the events as `/json/` gives them
function stubSentry() {
  const issues = [
    {
      id: '11',
      count: '120',
      userCount: 7,
      firstSeen: '2026-08-01T10:00:00Z',
      lastSeen: '2026-10-20T10:00:00Z',
      status: 'resolved',
      numComments: 1,
    },
    {
      id: '12',
      count: '5',
      userCount: 0,
      firstSeen: '2026-10-01T10:00:00Z',
      lastSeen: '2026-10-21T10:00:00Z',
      status: 'unresolved',
      numComments: 0,
    },
  ]
  const events: Record<string, unknown> = {
    e11: { ...fixture('python-zero-division'), event_id: 'e11e11e11e11e11e11e11e11e11e11e1' },
    e12: { ...fixture('ios-error'), event_id: 'e12e12e12e12e12e12e12e12e12e12e1' },
  }
  const calls: string[] = []
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer t')
    const path = url.pathname + url.search
    calls.push(path)
    const json = (body: unknown, headers: Record<string, string> = {}) => Response.json(body, { headers })
    if (path.startsWith('/api/0/projects/acme/shop/issues/'))
      return url.searchParams.get('cursor')
        ? json([], {
            link: '<x>; rel="previous"; results="true"; cursor="c1", <x>; rel="next"; results="false"; cursor="c3"',
          })
        : json(issues, {
            link: '<x>; rel="previous"; results="false"; cursor="c0", <x>; rel="next"; results="true"; cursor="c2"',
          })
    const latest = path.match(/issues\/(\d+)\/events\/latest\/$/)
    if (latest) return json({ eventID: `e${latest[1]}` })
    const raw = path.match(/events\/(e\d+)\/json\/$/)
    if (raw) return json(events[raw[1]])
    if (path.endsWith('/issues/11/comments/'))
      return json([
        { dateCreated: '2026-10-02T09:00:00Z', data: { text: 'Fixed in 2.1' }, user: { email: 'ana@example.com' } },
      ])
    return new Response('{}', { status: 404 })
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('importPage', () => {
  it('brings each issue with its latest event, Sentry’s numbers, status and comments, and skips them the next time', async () => {
    const db = sqliteD1()
    db.sqlite.exec("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'shop', 'Shop', 'k', 0)")
    const calls = stubSentry()
    expect(await importPage(db, 1, source, null)).toEqual({ imported: 2, skipped: 0, next: 'c2' })
    // An issue without comments isn't asked for them
    expect(calls.filter((c) => c.includes('/comments/'))).toEqual(['/api/0/organizations/acme/issues/11/comments/'])
    const issues = db.sqlite
      .prepare('SELECT title, count, user_count, status, substatus, first_seen FROM issues ORDER BY id')
      .all()
    expect(issues).toEqual([
      expect.objectContaining({
        title: 'ZeroDivisionError: division by zero',
        count: 120,
        user_count: 7,
        status: 'resolved',
        substatus: null,
        first_seen: Date.parse('2026-08-01T10:00:00Z'),
      }),
      expect.objectContaining({ count: 5, status: 'unresolved', substatus: 'ongoing' }),
    ])
    expect(db.sqlite.prepare("SELECT data, by FROM issue_activity WHERE kind = 'note'").all()).toEqual([
      { data: '{"text":"Fixed in 2.1"}', by: 'ana@example.com on Sentry' },
    ])
    expect(await importPage(db, 1, source, 'c2')).toEqual({ imported: 0, skipped: 0, next: null })

    // Again from the start: nothing twice
    expect(await importPage(db, 1, source, null)).toEqual({ imported: 0, skipped: 2, next: 'c2' })
    expect(db.sqlite.prepare('SELECT SUM(count) AS n FROM issues').get()).toEqual({ n: 125 })

    // The SDK's next event of the same error comes to the imported issue
    const project = db.sqlite.prepare('SELECT * FROM projects WHERE id = 1').get() as Project
    const next = await normalizeEvent({ ...fixture('python-zero-division'), event_id: 'f'.repeat(32) }, Date.now())
    const { fingerprint } = await groupingFor(db, project, next, Date.now())
    const stored = await storeEvent(db, project, next, fingerprint)
    expect(stored?.issue).toMatchObject({ title: 'ZeroDivisionError: division by zero', count: 121 })
  })

  it('says what to do when Sentry refuses the token', async () => {
    const db = sqliteD1()
    db.sqlite.exec("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'shop', 'Shop', 'k', 0)")
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }))
    await expect(importPage(db, 1, source, null)).rejects.toThrow('Sentry refused the token')
  })
})

describe('nextCursor', () => {
  it('follows Sentry’s Link header while it says there are results', () => {
    expect(
      nextCursor(
        '<a>; rel="previous"; results="false"; cursor="0:0:1", <b>; rel="next"; results="true"; cursor="0:10:0"',
      ),
    ).toBe('0:10:0')
    expect(nextCursor('<b>; rel="next"; results="false"; cursor="0:20:0"')).toBeNull()
    expect(nextCursor(null)).toBeNull()
  })
})
