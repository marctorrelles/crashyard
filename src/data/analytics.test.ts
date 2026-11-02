import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { actionsStatement, type Action } from '../ingest/actions'
import { hashUser } from '../search/user'
import { metricValue } from '../notify/metrics'
import { flows, funnel, overview, pruneActions, retention, users, userTimeline, walk } from './analytics'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 10, 2, 12)

function setup() {
  const db = sqliteD1()
  db.sqlite.exec(`
    INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'app', 'app', 'k', 0);
    INSERT INTO issues (id, project_id, fingerprint, title, first_seen, last_seen) VALUES (7, 1, 'f', 'Export crash', 0, 0);`)
  const act = (name: string, user: string | null, at: number, more: Partial<Action> = {}) =>
    actionsStatement(db, 1, [
      { name, timestamp: at, userHash: user ? hashUser(user) : undefined, properties: {}, ...more },
    ]).run()
  let n = 0
  const error = (user: string, at: number, level = 'fatal') =>
    db
      .prepare(
        "INSERT INTO events (id, project_id, issue_id, timestamp, received, level, platform, data, user_hash) VALUES (?, 1, 7, ?, ?, ?, 'cocoa', '{}', ?)",
      )
      .bind(String(++n).padStart(32, '0'), at, at, level, hashUser(user))
      .run()
  return { db, act, error }
}

describe('walk', () => {
  const rows = (...r: [string, number][]) => r.map(([name, at]) => ({ name, at, g: '' }))

  it('starts again from a first step done again, so a later visit converts', () => {
    const chain = walk(['opened', 'signed up'], rows(['opened', 0], ['opened', 7 * DAY], ['signed up', 7 * DAY + HOUR]))
    expect(chain?.at).toEqual([7 * DAY, 7 * DAY + HOUR])
  })

  it('holds each step to the window after the one before', () => {
    expect(walk(['a', 'b'], rows(['a', 0], ['b', 2 * DAY]))?.at).toEqual([0])
  })

  it('needs two of a step named twice', () => {
    expect(walk(['a', 'a', 'b'], rows(['a', 0], ['b', 1]))?.at).toEqual([0])
    expect(walk(['a', 'a', 'b'], rows(['a', 0], ['a', 1], ['b', 2]))?.at).toEqual([0, 1, 2])
  })
})

describe('analytics', () => {
  it('counts a funnel, and who stopped after an error, with its issue', async () => {
    const { db, act, error } = setup()
    const t = NOW - 2 * DAY
    for (const u of ['a', 'b', 'c']) await act('export started', u, t)
    await act('song exported', 'a', t + 1000)
    await error('b', t + 500)
    await error('c', t + 500, 'info') // not an error
    const f = await funnel(db, 1, ['export started', 'song exported'], 30, NOW)
    expect(f.steps.map((s) => s.users)).toEqual([3, 1])
    expect(f.steps[0]).toMatchObject({ dropped: 2, droppedWithError: 1 })
    expect(f.steps[0].issues).toEqual([{ id: 7, title: 'Export crash', level: 'error', users: 1 }])
  })

  it('splits retention by an error in the first week, not one before the first action', async () => {
    const { db, act, error } = setup()
    const first = NOW - 3 * WEEK_MS
    await act('opened', 'early', first)
    await error('early', first - HOUR) // before: doesn't count
    await act('opened', 'hurt', first)
    await error('hurt', first + DAY)
    await act('opened', 'hurt', first + WEEK_MS + DAY)
    const r = await retention(db, 1, 8, NOW)
    expect(r.users).toBe(2)
    expect(r.erredUsers).toBe(1)
  })

  it('counts actions without a user, but not per user', async () => {
    const { db, act } = setup()
    await act('landing viewed', null, NOW - HOUR)
    await act('signed up', 'a', NOW - HOUR)
    const o = await overview(db, 1, 7, NOW)
    expect(o).toMatchObject({ actions: 2, users: 1, anonymous: 1, perUser: 1 })
  })

  it('filters by a column and a property, booleans as true and false', async () => {
    const { db, act } = setup()
    await act('opened', 'a', NOW - HOUR, { platform: 'Apple', properties: { pro: true } })
    await act('opened', 'b', NOW - HOUR, { platform: 'Web', properties: { pro: false } })
    expect((await overview(db, 1, 7, NOW, { platform: 'Web' })).users).toBe(1)
    expect((await overview(db, 1, 7, NOW, { prop: { key: 'pro', value: 'true' } })).users).toBe(1)
  })

  it('follows what people did after an action, an error among the steps', async () => {
    const { db, act, error } = setup()
    await act('export started', 'a', NOW - HOUR)
    await error('a', NOW - HOUR + 1000)
    await act('export started', 'b', NOW - HOUR)
    await act('song exported', 'b', NOW - HOUR + 2000)
    const f = await flows(db, 1, 'export started', 'after', 7, NOW)
    expect(f.users).toBe(2)
    expect(f.columns[0].items.map((i) => i.label).sort()).toEqual(['error:7', 'song exported'])
    expect(f.issues[7]).toMatchObject({ title: 'Export crash' })
  })

  it('lists users and one user’s timeline, actions and errors in time order', async () => {
    const { db, act, error } = setup()
    await act('opened', 'a', NOW - 2 * HOUR, { properties: { plan: 'free' } })
    await act('subscribed', 'a', NOW - HOUR, { properties: { plan: 'yearly' } })
    await error('a', NOW - 90 * 60_000)
    const list = await users(db, 1, 7, NOW)
    expect(list.list[0]).toMatchObject({ user: hashUser('a'), actions: 2, errors: 1 })
    const t = await userTimeline(db, 1, hashUser('a'))
    expect(t.timeline.map((x) => x.kind)).toEqual(['action', 'error', 'action'])
    expect(t.properties).toEqual({ plan: 'yearly' })
  })

  it('alerts on an action’s count, by name in the filter', async () => {
    const { db, act } = setup()
    await act('checkout completed', 'a', NOW - HOUR / 2, { platform: 'Web' })
    await act('checkout completed', 'b', NOW - HOUR / 2, { platform: 'Apple' })
    await act('opened', 'a', NOW - HOUR / 2)
    const alert = { project_id: 1, metric: 'actions' as const, window_hours: 1 }
    expect(await metricValue(db, { ...alert, query: 'action:"checkout completed"' }, NOW)).toBe(2)
    expect(await metricValue(db, { ...alert, query: 'action:"checkout completed" platform:Web' }, NOW)).toBe(1)
  })

  it('prunes actions past their project’s retention', async () => {
    const { db, act } = setup()
    await act('old', 'a', NOW - 400 * DAY)
    await act('new', 'a', NOW - DAY)
    expect(await pruneActions(db, NOW)).toEqual({ actions: 1 })
  })
})

const WEEK_MS = 7 * DAY
