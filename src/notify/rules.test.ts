import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { normalizeEvent } from '../ingest/event'
import { type Project, storeEvent } from '../ingest/store'
import type { Route } from './notice'
import { frequencyCrossed, frequencyHits, matchesFilters, tagFilterError, throttled } from './rules'

const MINUTE = 60_000
const DAY = 864e5
const T0 = Date.UTC(2026, 9, 1)
const project = { id: 1, slug: 'pocketband', name: 'pocketband' } as Project

const route = (over: Partial<Route> = {}): Route => ({
  id: 1,
  project_id: null,
  kinds: '["frequency"]',
  levels: null,
  environments: null,
  thresholds: '[]',
  channel_ids: '[1]',
  frequency: '{"events":50,"minutes":10}',
  releases: null,
  query: null,
  interval_minutes: 0,
  ...over,
})

function setup() {
  const db = sqliteD1()
  db.sqlite.exec("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'pocketband', 'p', 'k', 0)")
  db.sqlite.exec("INSERT INTO routes (id, kinds, channel_ids, created_at) VALUES (1, '[]', '[]', 0)")
  return db
}

/** Stores one event of the same issue at each time, and says after which ones the route's frequency fired */
async function firings(r: Route, times: number[], user?: (i: number) => string) {
  const db = setup()
  const fired: number[] = []
  for (const [i, at] of times.entries()) {
    const e = await normalizeEvent({ message: 'Audio engine crashed', ...(user && { user: { id: user(i) } }) }, at)
    const stored = (await storeEvent(db, project, e, 'one'))!
    const hits = await frequencyHits(db, [r], {
      issueId: stored.issue.id,
      issueCount: stored.issue.count,
      eventId: e.id,
      received: at,
      userHash: e.userHash,
      kept: stored.stored,
    })
    if (hits.length) fired.push(i + 1)
  }
  return fired
}

describe('frequency', () => {
  it('fires on the 50th event of an issue within 10 minutes, once', async () => {
    // One every 10 seconds: the 50th comes after 490 seconds, and the window never drops below 50 after
    const times = Array.from({ length: 80 }, (_, i) => T0 + i * 10_000)
    expect(await firings(route(), times)).toEqual([50])
  })

  it('doesn’t fire for 365 events, one a day', async () => {
    const times = Array.from({ length: 365 }, (_, i) => T0 + i * DAY)
    expect(await firings(route(), times)).toEqual([])
    expect(await firings(route({ frequency: '{"events":2,"minutes":1440}' }), times)).toEqual([])
  })

  it('counts distinct users', async () => {
    // Each of 12 users twice in a row: the 10th user's first event is the 19th
    const times = Array.from({ length: 24 }, (_, i) => T0 + i * MINUTE)
    const r = route({ frequency: '{"users":10,"minutes":60}' })
    expect(await firings(r, times, (i) => `user-${Math.floor(i / 2)}`)).toEqual([19])
    // Three users, however many events: never
    expect(await firings(r, times, (i) => `user-${i % 3}`)).toEqual([])
  })

  it('reads a limit crossed only from below it', () => {
    const r = route()
    expect(frequencyCrossed(r, { events: 50, eventsBefore: 49, users: 0, usersBefore: 0 })).toBe(true)
    expect(frequencyCrossed(r, { events: 51, eventsBefore: 50, users: 0, usersBefore: 0 })).toBe(false)
    expect(
      frequencyCrossed(route({ frequency: '{"events":50,"minutes":7}' }), {
        events: 50,
        eventsBefore: 49,
        users: 0,
        usersBefore: 0,
      }),
    ).toBe(false)
  })
})

describe('waiting before alerting again', () => {
  it('fires once and not again while interval_minutes holds, per route and issue', async () => {
    const db = setup()
    db.sqlite.exec("INSERT INTO routes (id, kinds, channel_ids, created_at) VALUES (2, '[]', '[]', 0)")
    const e = await normalizeEvent({ message: 'crash' }, T0)
    const issue = (await storeEvent(db, project, e, 'one'))!.issue.id
    const other = (await storeEvent(db, project, await normalizeEvent({ message: 'other' }, T0), 'two'))!.issue.id
    const r = route({ interval_minutes: 60 })
    expect(await throttled(db, r, issue, T0)).toBe(false)
    expect(await throttled(db, r, issue, T0 + 30 * MINUTE)).toBe(true)
    expect(await throttled(db, r, other, T0 + 30 * MINUTE)).toBe(false)
    expect(await throttled(db, route({ id: 2, interval_minutes: 60 }), issue, T0 + 30 * MINUTE)).toBe(false)
    expect(await throttled(db, r, issue, T0 + 59 * MINUTE)).toBe(true)
    expect(await throttled(db, r, issue, T0 + 60 * MINUTE)).toBe(false)
    expect(await throttled(db, route({ interval_minutes: 0 }), issue, T0 + 61 * MINUTE)).toBe(false)
  })
})

describe('filters', () => {
  const event = (over: Record<string, string> = {}, release = '1.2.3') => ({
    release,
    environment: 'production',
    level: 'fatal',
    tags: { 'os.name': 'iOS', os: 'iOS 17.2', device: 'iPhone15,2', ...over },
  })

  it('match release globs and tag filters against the event’s tags', () => {
    const r = route({ releases: '["1.2.*","2.0"]', query: 'os:iOS !device:iPad*' })
    expect(matchesFilters(r, event())).toBe(true)
    expect(matchesFilters(r, event({ device: 'iPad13,1' }))).toBe(false)
    expect(matchesFilters(r, event({ 'os.name': 'Android', os: 'Android 14' }))).toBe(false)
    expect(matchesFilters(r, event({}, '1.3.0'))).toBe(false)
    expect(matchesFilters(r, event({}, '2.0'))).toBe(true)
    expect(matchesFilters(r, { level: 'fatal' })).toBe(false) // no release to match
    expect(matchesFilters(route({ query: 'device:[iPhone*,Mac*] has:os level:fatal' }), event())).toBe(true)
    expect(matchesFilters(route({ query: '!has:locale' }), event())).toBe(true)
    expect(matchesFilters(route(), event())).toBe(true)
  })

  it('refuse what can’t filter one event', () => {
    expect(tagFilterError('os:iOS !device:iPad*')).toBeNull()
    expect(tagFilterError('crash')).toMatch(/has no key/)
    expect(tagFilterError('times:>10')).toMatch(/colon/)
    expect(tagFilterError('is:unresolved')).toMatch(/describes an issue/)
  })
})
