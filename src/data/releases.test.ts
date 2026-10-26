import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { sessionCounts, storeSessions } from '../performance/ingest'
import { adoptionByDay, adoptionStage, healthOf, listReleases, releaseHealth } from './releases'

const NOW = Date.UTC(2026, 9, 26, 12)
const started = Date.UTC(2026, 9, 26, 9) / 1000

function project() {
  const db = sqliteD1()
  db.sqlite.exec("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'ka', 0)")
  return db
}

const session = (did: string | undefined, status: string, release = '1.0', init = true) =>
  sessionCounts('session', { did, init, status, started, attrs: { release, environment: 'production' } }, NOW)

describe('sessions with users', () => {
  it('count distinct users per release and day, as a salted hash, never the id', async () => {
    const db = project()
    for (const s of [
      session('ada', 'exited'),
      session('ada', 'exited'),
      session('bob', 'crashed'),
      session('', 'exited'),
      session(undefined, 'exited'),
      // A later update of Ada's that changes no count: still one user
      session('ada', 'ok', '1.0', false),
    ])
      await storeSessions(db, 1, s)
    const rows = db.sqlite.prepare('SELECT did_hash, crashed FROM session_users_daily ORDER BY crashed').all()
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.crashed)).toEqual([0, 1])
    expect(JSON.stringify(rows)).not.toContain('ada')
    const h = (await releaseHealth(db, 1, NOW)).get('1.0')!
    expect(h).toMatchObject({ sessions: 5, crashed: 1, users: 2, crashedUsers: 1 })
    expect(h.crashFreeUsers).toBe(0.5)
    expect(h.crashFree).toBe(0.8)
  })

  it('aggregates carry their did too', () => {
    expect(
      sessionCounts('sessions', { attrs: { release: 'r' }, aggregates: [{ started, did: 'ada', exited: 3 }] }, NOW),
    ).toMatchObject([{ started: 3, did: 'ada' }])
  })
})

describe('adoption', () => {
  it('is a release’s share of the last 24 hours’ sessions', async () => {
    const db = project()
    db.sqlite.exec(`INSERT INTO sessions_daily (project_id, release, environment, day, started) VALUES
      (1, '1.0', 'production', '2026-10-01', 100), (1, '1.0', 'production', '2026-10-26', 30),
      (1, '1.1', 'production', '2026-10-25', 60), (1, '1.1', 'production', '2026-10-26', 5),
      (1, '0.9', 'production', '2026-10-26', 5), (1, '0.9', 'production', '2026-09-01', 1)`)
    const health = await releaseHealth(db, 1, NOW)
    expect(health.get('1.1')!.adoption).toBe(0.65)
    expect(health.get('1.0')!.adoption).toBe(0.3)
    expect(health.get('0.9')!.adoption).toBe(0.05)
    const days = await adoptionByDay(db, 1, '1.1', NOW)
    expect(days).toHaveLength(30)
    expect(days.at(-1)).toMatchObject({ day: '2026-10-26', adoption: 0.125 })
    expect(days.at(-2)).toMatchObject({ day: '2026-10-25', adoption: 1 })
    expect(days[0].adoption).toBeNull()
    // Releases with sessions and no events are releases too, newest first
    expect((await listReleases(db, 1)).map((r) => r.release)).toEqual(['1.1', '1.0', '0.9'])
  })

  it('reads adopted from 10%, replaced once a newer release has more, else low', () => {
    expect(adoptionStage(0.1, [])).toBe('adopted')
    expect(adoptionStage(0.04, [0.9])).toBe('replaced')
    expect(adoptionStage(0.04, [0.01])).toBe('low')
    expect(adoptionStage(0.04, [])).toBe('low')
    expect(adoptionStage(null, [0.5])).toBeNull()
  })
})

describe('release health', () => {
  const t = { release_crash_free_min: 0.995, release_new_issues_max: 3 }
  it('is healthy within every threshold set, and says which one it crossed', () => {
    expect(healthOf(t, { crashFree: 0.997, newIssues: 3 })).toEqual({ healthy: true, failed: [] })
    expect(healthOf(t, { crashFree: 0.99, newIssues: 4 })).toEqual({
      healthy: false,
      failed: ['crash-free sessions', 'new issues'],
    })
    expect(healthOf({ ...t, release_new_issues_max: null }, { crashFree: null, newIssues: 9 })).toBeNull()
    expect(
      healthOf({ release_crash_free_min: null, release_new_issues_max: null }, { crashFree: 1, newIssues: 0 }),
    ).toBeNull()
  })
})
