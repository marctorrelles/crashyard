import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { addUpdate, createPage, createPost, setCheck, slugify, slugOfDomain, statusPage } from './status'

const DAY = 86_400_000
const now = Date.UTC(2026, 9, 27, 12)

describe('statusPage', () => {
  it('shows only the uptime checks chosen for it, by name, never their address or why they failed', async () => {
    const db = sqliteD1()
    db.sqlite.exec(`
      INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'shop', 'Shop', 'k1', 0), (2, 'quiet', 'Quiet', 'k2', 0);
      INSERT INTO monitors (id, project_id, slug, name, kind, config, status, created_at) VALUES
        (1, 1, 'api', 'API', 'uptime', '{"url":"https://secret.internal/health"}', 'failing', 0),
        (2, 1, 'admin', 'Admin', 'uptime', '{"url":"https://admin.internal"}', 'ok', 0),
        (3, 1, 'job', 'Nightly job', 'cron', '{}', 'ok', 0),
        (4, 2, 'web', 'Web', 'uptime', '{"url":"https://quiet.example"}', 'ok', 0);
      INSERT INTO status_pages (id, slug, name, created_at) VALUES (1, 'shop', 'Shop', 0), (2, 'quiet', 'Quiet', 0);
      INSERT INTO uptime_results (monitor_id, at, ok, error) VALUES
        (1, ${now - 2 * DAY}, 1, NULL), (1, ${now - 2 * DAY + 1}, 1, NULL),
        (1, ${now - 1000}, 1, NULL), (1, ${now - 500}, 0, 'connection refused to 10.0.0.3');
      INSERT INTO incidents (monitor_id, opened_at, closed_at, reason) VALUES
        (1, ${now - 400}, NULL, 'connection refused to 10.0.0.3'),
        (1, ${now - 40 * DAY}, ${now - 40 * DAY + 1}, 'error');
    `)
    await setCheck(db, 1, 1, true)
    // A cron monitor can't be on a page
    await setCheck(db, 1, 3, true)
    const page = await statusPage(db, 'shop', now)
    expect(page?.checks.map((c) => [c.name, c.status, c.uptime])).toEqual([['API', 'failing', 0.75]])
    expect(page?.checks[0].days.slice(-3).map((d) => d.up)).toEqual([1, null, 0.5])
    expect(page?.incidents).toEqual([{ check: 'API', opened: now - 400, closed: null }])
    expect(JSON.stringify(page)).not.toMatch(/internal|10\.0\.0|refused/)
    // A page with nothing shown is no page, the same as one that doesn't exist
    expect(await statusPage(db, 'quiet', now)).toBeNull()
    expect(await statusPage(db, 'nope', now)).toBeNull()
  })

  it('shows what the team posts, where each stands, and never who posted it', async () => {
    const db = sqliteD1()
    db.sqlite.exec("INSERT INTO status_pages (id, slug, name, created_at) VALUES (1, 'quiet', 'Quiet', 0)")
    const post = (title: string, impact: 'minor' | 'notice' | 'maintenance', at: number, window?: [number, number]) =>
      createPost(
        db,
        1,
        {
          title,
          impact,
          state: impact === 'minor' ? 'investigating' : 'update',
          message: `About ${title}`,
          starts: window?.[0] ?? null,
          ends: window?.[1] ?? null,
          monitors: [],
        },
        'ana@example.com',
        at,
      )
    const slow = await post('Slow checkouts', 'minor', now - 3600_000)
    await addUpdate(db, slow, 'identified', 'A full disk', 'ana@example.com', now - 1800_000)
    const old = await post('Login errors', 'minor', now - 40 * DAY)
    await addUpdate(db, old, 'resolved', 'Fixed', 'ana@example.com', now - 40 * DAY + 1)
    await post('Database upgrade', 'maintenance', now - DAY, [now + DAY, now + DAY + 3600_000])
    await post('Last week’s upgrade', 'maintenance', now - 8 * DAY, [now - 7 * DAY, now - 7 * DAY + 3600_000])
    await post('New status page', 'notice', now - 60_000)

    // No uptime check shown, yet the posts make a page
    const page = await statusPage(db, 'quiet', now)
    expect(page?.posts.map((p) => [p.title, p.phase])).toEqual([
      ['Database upgrade', 'upcoming'],
      ['New status page', 'open'],
      ['Slow checkouts', 'open'],
      ['Last week’s upgrade', 'past'],
    ])
    expect(page?.posts[2].updates.map((u) => u.state)).toEqual(['identified', 'investigating'])
    expect(JSON.stringify(page)).not.toContain('ana@example.com')
    // Resolved, it moves to the past; another update opens it again
    await addUpdate(db, slow, 'resolved', 'Done', 'ana@example.com', now)
    expect((await statusPage(db, 'quiet', now + 1))?.posts.find((p) => p.title === 'Slow checkouts')?.phase).toBe(
      'past',
    )
    await addUpdate(db, slow, 'monitoring', 'Watching it', 'ana@example.com', now + 2)
    expect((await statusPage(db, 'quiet', now + 3))?.posts.find((p) => p.title === 'Slow checkouts')?.phase).toBe(
      'open',
    )
  })

  it('marks the checks a post affects, names only those on the page, and finds a page by its domain', async () => {
    const db = sqliteD1()
    db.sqlite.exec(`
      INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'shop', 'Shop', 'k1', 0), (2, 'other', 'Other', 'k2', 0);
      INSERT INTO monitors (id, project_id, slug, name, kind, config, status, created_at) VALUES
        (1, 1, 'api', 'API', 'uptime', '{}', 'ok', 0),
        (2, 1, 'admin', 'Admin', 'uptime', '{}', 'ok', 0),
        (3, 1, 'web', 'Web', 'uptime', '{}', 'ok', 0),
        (4, 2, 'theirs', 'Theirs', 'uptime', '{}', 'ok', 0);
      INSERT INTO status_pages (id, slug, name, domain, branding, created_at) VALUES
        (1, 'shop', 'Shop', 'status.shop.example', '{"title":"Shop status","color":"#f97316"}', 0),
        (2, 'other', 'Other', NULL, NULL, 0);
      INSERT INTO status_page_monitors (page_id, monitor_id) VALUES (1, 1), (1, 3), (2, 4);
    `)
    const id = await createPost(
      db,
      1,
      {
        title: 'Slow API',
        impact: 'minor',
        state: 'investigating',
        message: 'Looking',
        starts: null,
        ends: null,
        monitors: [1, 2, 4],
      },
      'ana@example.com',
      now - 1000,
    )
    let page = await statusPage(db, 'shop', now)
    expect(page?.branding).toEqual({ title: 'Shop status', color: '#f97316' })
    // A check off the page is never linked, whatever its project
    expect(page?.posts[0].affects).toEqual(['API'])
    expect(page?.checks.map((c) => [c.name, c.affected])).toEqual([
      ['API', 'minor'],
      ['Web', null],
    ])
    // An update can move what it affects; resolved, nothing is affected
    await addUpdate(db, id, 'identified', 'Found it', 'ana@example.com', now - 500, [3])
    page = await statusPage(db, 'shop', now)
    expect(page?.checks.map((c) => c.affected)).toEqual([null, 'minor'])
    await addUpdate(db, id, 'resolved', 'Fixed', 'ana@example.com', now - 100)
    page = await statusPage(db, 'shop', now)
    expect(page?.checks.map((c) => c.affected)).toEqual([null, null])
    expect(page?.posts[0].affects).toEqual(['Web'])

    expect(await slugOfDomain(db, 'Status.Shop.Example', now)).toBe('shop')
    expect(await slugOfDomain(db, 'crashyard.example', now)).toBeUndefined()
  })

  it('shows checks from several projects, each with its project, and a check on more than one page', async () => {
    const db = sqliteD1()
    db.sqlite.exec(`
      INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'caliu', 'Caliu', 'k1', 0), (2, 'band', 'pocketband', 'k2', 0);
      INSERT INTO monitors (id, project_id, slug, name, kind, config, status, created_at) VALUES
        (1, 1, 'api', 'API', 'uptime', '{}', 'ok', 0),
        (2, 2, 'sync', 'Sync', 'uptime', '{}', 'failing', 0);
    `)
    const all = await createPage(db, 'All services', now)
    const caliu = await createPage(db, 'Caliu', now)
    expect([all, caliu, await createPage(db, 'All services!', now), slugify('Ñandú ★')]).toEqual([
      'all-services',
      'caliu',
      'all-services-2',
      'nandu',
    ])
    const id = (slug: string) =>
      (db.sqlite.prepare('SELECT id FROM status_pages WHERE slug = ?').get(slug) as { id: number }).id
    for (const m of [1, 2]) await setCheck(db, id(all), m, true)
    await setCheck(db, id(caliu), 1, true)
    expect((await statusPage(db, all, now))?.checks.map((c) => [c.project, c.name, c.status])).toEqual([
      ['Caliu', 'API', 'ok'],
      ['pocketband', 'Sync', 'failing'],
    ])
    expect((await statusPage(db, caliu, now))?.checks.map((c) => c.name)).toEqual(['API'])
    // Deleting a project takes its checks off every page, and the page stays
    db.sqlite.exec('PRAGMA foreign_keys = ON; DELETE FROM projects WHERE id = 2')
    expect((await statusPage(db, all, now))?.checks.map((c) => c.name)).toEqual(['API'])
  })
})
