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

/** An issue's events and distinct users in a window, up to and without the event just stored */
export type IssueStats = { events: number; eventsBefore: number; users: number; usersBefore: number }

/** What the event reached: the route's limit, from below it to it, so a steady count past it doesn't fire again */
export function crossedBy(f: Frequency, stats: IssueStats): 'events' | 'users' | undefined {
  if (f.events && stats.eventsBefore < f.events && stats.events >= f.events) return 'events'
  if (f.users && stats.usersBefore < f.users && stats.users >= f.users) return 'users'
  return undefined
}

export const frequencyCrossed = (route: Pick<Route, 'frequency'>, stats: IssueStats): boolean => {
  const f = frequencyOf(route.frequency)
  return !!f && !!crossedBy(f, stats)
}

export type StoredEvent = {
  issueId: number
  issueCount: number // the issue's count with this event: a window can't hold more
  eventId: string
  received: number
  userHash?: string
  kept: boolean // false when spike protection counted it without storing it, so it isn't in `events`
}

/**
 * An issue's events and users in the window ending at this event, from `events` by `events_issue`. Each count reads
 * at most one more than the limit: only whether the event took it from below to the limit matters
 */
export async function windowStats(db: D1Database, at: StoredEvent, f: Frequency): Promise<IssueStats> {
  const from = at.received - f.minutes * 60_000
  let events = 0
  if (f.events && at.issueCount >= f.events) {
    const row = await db
      .prepare(
        'SELECT COUNT(*) AS n FROM (SELECT 1 FROM events WHERE issue_id = ? AND received > ? AND received <= ? LIMIT ?)',
      )
      .bind(at.issueId, from, at.received, f.events + 1)
      .first<{ n: number }>()
    events = row?.n ?? 0
  }
  let users = 0
  let usersBefore = 0
  if (f.users) {
    const [distinct, seen] = await db.batch<{ n: number }>([
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM (SELECT DISTINCT user_hash FROM events
           WHERE issue_id = ? AND received > ? AND received <= ? AND user_hash IS NOT NULL LIMIT ?)`,
        )
        .bind(at.issueId, from, at.received, f.users + 1),
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM (SELECT 1 FROM events
           WHERE issue_id = ? AND received > ? AND received <= ? AND user_hash = ? AND id != ? LIMIT 1)`,
        )
        .bind(at.issueId, from, at.received, at.userHash ?? '', at.eventId),
    ])
    users = distinct.results[0]?.n ?? 0
    const added = at.kept && !!at.userHash && !seen.results[0]?.n
    usersBefore = users - (added ? 1 : 0)
  }
  return { events, eventsBefore: events - (at.kept && events > 0 ? 1 : 0), users, usersBefore }
}

/** The routes whose frequency this event reached, with what it reached, for a `frequency` notice each */
export async function frequencyHits(
  db: D1Database,
  routes: Route[],
  at: StoredEvent,
): Promise<{ route: Route; rate: NonNullable<Notice['rate']> }[]> {
  const hits: { route: Route; rate: NonNullable<Notice['rate']> }[] = []
  for (const route of routes) {
    const f = frequencyOf(route.frequency)
    if (!f) continue
    const stats = await windowStats(db, at, f)
    const what = crossedBy(f, stats)
    if (what) hits.push({ route, rate: { count: what === 'events' ? f.events! : f.users!, what, minutes: f.minutes } })
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
