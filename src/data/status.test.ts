import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { addUpdate, createPost, statusPage } from './status'

const DAY = 86_400_000
const now = Date.UTC(2026, 9, 27, 12)

describe('statusPage', () => {
  it('shows only the uptime checks chosen for it, by name, never their address or why they failed', async () => {
    const db = sqliteD1()
    db.sqlite.exec(`
      INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'shop', 'Shop', 'k1', 0), (2, 'quiet', 'Quiet', 'k2', 0);
      INSERT INTO monitors (id, project_id, slug, name, kind, config, status, public, created_at) VALUES
        (1, 1, 'api', 'API', 'uptime', '{"url":"https://secret.internal/health"}', 'failing', 1, 0),
        (2, 1, 'admin', 'Admin', 'uptime', '{"url":"https://admin.internal"}', 'ok', 0, 0),
        (3, 1, 'job', 'Nightly job', 'cron', '{}', 'ok', 1, 0),
        (4, 2, 'web', 'Web', 'uptime', '{"url":"https://quiet.example"}', 'ok', 0, 0);
      INSERT INTO uptime_results (monitor_id, at, ok, error) VALUES
        (1, ${now - 2 * DAY}, 1, NULL), (1, ${now - 2 * DAY + 1}, 1, NULL),
        (1, ${now - 1000}, 1, NULL), (1, ${now - 500}, 0, 'connection refused to 10.0.0.3');
      INSERT INTO incidents (monitor_id, opened_at, closed_at, reason) VALUES
        (1, ${now - 400}, NULL, 'connection refused to 10.0.0.3'),
        (1, ${now - 40 * DAY}, ${now - 40 * DAY + 1}, 'error');
    `)
    const page = await statusPage(db, 'shop', now)
    expect(page?.checks.map((c) => [c.name, c.status, c.uptime])).toEqual([['API', 'failing', 0.75]])
    expect(page?.checks[0].days.slice(-3).map((d) => d.up)).toEqual([1, null, 0.5])
    expect(page?.incidents).toEqual([{ check: 'API', opened: now - 400, closed: null }])
    expect(JSON.stringify(page)).not.toMatch(/internal|10\.0\.0|refused/)
    // A project with nothing shown has no page, the same as one that doesn't exist
    expect(await statusPage(db, 'quiet', now)).toBeNull()
    expect(await statusPage(db, 'nope', now)).toBeNull()
  })

  it('shows what the team posts, where each stands, and never who posted it', async () => {
    const db = sqliteD1()
    db.sqlite.exec("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'quiet', 'Quiet', 'k', 0)")
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
})
