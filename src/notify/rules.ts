// Routes on rates: a frequency an issue reaches in a window, release and tag filters, and a wait between alerts.
import { tokenize } from '../search/query'
import type { Notice, Route } from './notice'

/** The windows a frequency can count over, in minutes */
export const WINDOWS = [5, 10, 30, 60, 1440] as const
/** "Wait before alerting again", in minutes: off, 10 minutes, an hour, a day */
export const INTERVALS = [0, 10, 60, 1440] as const

export type Frequency = { events?: number; users?: number; minutes: (typeof WINDOWS)[number] }

const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined)

/** A route's frequency, if it has one that reads */
export function frequencyOf(json: string | null | undefined): Frequency | null {
  if (!json) return null
  try {
    const f = JSON.parse(json) as Record<string, unknown>
    if (!f || typeof f !== 'object' || !WINDOWS.includes(f.minutes as Frequency['minutes'])) return null
    const events = count(f.events)
    const users = count(f.users)
    if (!events && !users) return null
    return { ...(events && { events }), ...(users && { users }), minutes: f.minutes as Frequency['minutes'] }
  } catch {
    return null
  }
}

/** An issue's events and distinct users in a window ending at an event */
export type IssueStats = { events: number; users: number }

/** What reached the route's limit in the window, if anything: the count at it or over it */
function reachedBy(f: Frequency, stats: IssueStats): 'events' | 'users' | undefined {
  if (f.events && stats.events >= f.events) return 'events'
  if (f.users && stats.users >= f.users) return 'users'
  return undefined
}

export type StoredEvent = {
  issueId: number
  issueCount: number // the issue's count with this event: a window can't hold more
  received: number
}

/**
 * An issue's events and users in the window ending at this event. Events from `issue_minutes`, every one spike
 * protection counted too, over the window's whole minutes up to the event's own; users from the events kept, by
 * `events_issue`, reading at most one more than the limit
 */
export async function windowStats(db: D1Database, at: StoredEvent, f: Frequency): Promise<IssueStats> {
  let events = 0
  if (f.events && at.issueCount >= f.events) {
    const minute = Math.floor(at.received / 60_000)
    const row = await db
      .prepare(
        'SELECT COALESCE(SUM(count), 0) AS n FROM issue_minutes WHERE issue_id = ? AND minute > ? AND minute <= ?',
      )
      .bind(at.issueId, minute - f.minutes, minute)
      .first<{ n: number }>()
    events = row?.n ?? 0
  }
  let users = 0
  if (f.users) {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM (SELECT DISTINCT user_hash FROM events
         WHERE issue_id = ? AND received > ? AND received <= ? AND user_hash IS NOT NULL LIMIT ?)`,
      )
      .bind(at.issueId, at.received - f.minutes * 60_000, at.received, f.users + 1)
      .first<{ n: number }>()
    users = row?.n ?? 0
  }
  return { events, users }
}

/**
 * Whether the route may fire for the issue: it hasn't within the window before this event. Recorded in the same
 * statement (`route_fires.frequency_at`, apart from the wait's `at`), so events stored at once, or out of order, fire
 * once
 */
async function mayFire(db: D1Database, routeId: number, issueId: number, received: number, minutes: number) {
  try {
    const row = await db
      .prepare(
        `INSERT INTO route_fires (route_id, issue_id, at, frequency_at) VALUES (?, ?, 0, ?)
         ON CONFLICT DO UPDATE SET frequency_at = excluded.frequency_at
         WHERE frequency_at IS NULL OR frequency_at <= excluded.frequency_at - ? RETURNING 1`,
      )
      .bind(routeId, issueId, received, minutes * 60_000)
      .first()
    return !!row
  } catch (error) {
    // Can't record it: an alert too many beats one missed
    console.error('notify: route_fires frequency', error)
    return true
  }
}

/**
 * The routes whose frequency fires on this event, with what it reached, for a `frequency` notice each: the count in
 * the window is at the limit or over it, and the route hasn't fired for the issue within the window
 */
export async function frequencyHits(
  db: D1Database,
  routes: Route[],
  at: StoredEvent,
): Promise<{ route: Route; rate: NonNullable<Notice['rate']> }[]> {
  const hits: { route: Route; rate: NonNullable<Notice['rate']> }[] = []
  for (const route of routes) {
    const f = frequencyOf(route.frequency)
    if (!f) continue
    const what = reachedBy(f, await windowStats(db, at, f))
    if (what && (await mayFire(db, route.id, at.issueId, at.received, f.minutes)))
      hits.push({ route, rate: { count: what === 'events' ? f.events! : f.users!, what, minutes: f.minutes } })
  }
  return hits
}

const globs = (json: string | null | undefined): string[] => {
  if (!json) return []
  try {
    const value = JSON.parse(json) as unknown
    return Array.isArray(value) ? value.filter((g): g is string => typeof g === 'string' && g !== '') : []
  } catch {
    return []
  }
}

/** `*` is any run of characters, the rest as it is, case-sensitive: the search's GLOB */
export const globMatch = (glob: string, value: string) =>
  new RegExp(
    `^${glob
      .split('*')
      .map((part) => part.replace(/[\\^$.+?()[\]{}|]/g, '\\$&'))
      .join('.*')}$`,
  ).test(value)

// A key's value on an event: its tag, else its field; `os:iOS` also matches `os.name`, as `os` holds the version too
function valuesOf(event: Notice['event'], key: string): string[] {
  const fields: Record<string, string | undefined> = {
    release: event.release,
    environment: event.environment,
    level: event.level,
    os: event.os,
    device: event.device,
  }
  return [event.tags?.[key] ?? fields[key], event.tags?.[`${key}.name`]].filter((v): v is string => v !== undefined)
}

/** Whether an event passes a route's release globs and tag filter (`os:iOS !device:iPad*`, lists, `has:`) */
export function matchesFilters(route: Pick<Route, 'releases' | 'query'>, event: Notice['event']): boolean {
  const releases = globs(route.releases)
  if (releases.length && !releases.some((g) => event.release !== undefined && globMatch(g, event.release))) return false
  if (!route.query) return true
  return tokenize(route.query).every((t) => {
    if (!t.key || t.op !== ':') return true // refused when the route is saved
    const wanted = t.values ?? [t.value]
    const hit =
      t.key === 'has'
        ? wanted.some((k) => valuesOf(event, k).length > 0)
        : valuesOf(event, t.key).some((v) => wanted.some((g) => globMatch(g, v)))
    return t.negate ? !hit : hit
  })
}

// Keys of the issue search that say something about an issue, not one event
const ISSUE_ONLY = new Set([
  'is',
  'times',
  'events',
  'users',
  'lastSeen',
  'firstSeen',
  'firstRelease',
  'lastRelease',
  'project',
  'trace',
  'type',
  'platform',
])

/** Why a route's tag filter can't be used, or null when it can */
export function tagFilterError(query: string): string | null {
  for (const t of tokenize(query)) {
    if (!t.key) return `“${t.value}” has no key. Filter by tags such as os:iOS or device:iPad*.`
    if (t.op !== ':') return `Tag filters match with a colon, such as ${t.key}:${t.value}.`
    if (ISSUE_ONLY.has(t.key)) return `${t.key} describes an issue, not an event. Filter by tags such as os:iOS.`
  }
  return null
}

/**
 * Whether the route alerted on this issue within its wait (`interval_minutes`); if not, this alert is recorded as its
 * last, in the same statement, so two at once can't both pass
 */
export async function throttled(
  db: D1Database,
  route: Pick<Route, 'id' | 'interval_minutes'>,
  issueId: number,
  now: number,
): Promise<boolean> {
  const minutes = route.interval_minutes ?? 0
  if (!minutes) return false
  try {
    const row = await db
      .prepare(
        `INSERT INTO route_fires (route_id, issue_id, at) VALUES (?, ?, ?)
         ON CONFLICT DO UPDATE SET at = excluded.at WHERE at <= excluded.at - ? RETURNING at`,
      )
      .bind(route.id, issueId, now, minutes * 60_000)
      .first()
    return !row
  } catch (error) {
    // An issue deleted meanwhile: nothing to hold back
    console.error('notify: route_fires', error)
    return false
  }
}
