// What's worth telling someone about an issue, and which routes it goes through.
import { matchesFilters } from './rules'

export type NoticeKind =
  | 'new'
  | 'threshold'
  | 'regression'
  | 'ignore_expired'
  | 'review_crash'
  | 'monitor_down'
  | 'monitor_up'
  | 'slower_release'
  | 'weekly'
  | 'frequency'
  | 'escalating'
  | 'metric_warning'
  | 'metric_critical'
  | 'metric_resolved'

/** What a route picks: a notice's kind, with `metric` for all three of a metric alert's */
export type RouteKind = Exclude<NoticeKind, `metric_${string}`> | 'metric'
export const routeKindOf = (kind: NoticeKind): RouteKind =>
  kind.startsWith('metric_') ? 'metric' : (kind as RouteKind)

/** Kinds about one issue, and so one event: a route's release and tag filters and its wait apply to these */
export const ISSUE_KINDS = new Set<NoticeKind>([
  'new',
  'threshold',
  'regression',
  'ignore_expired',
  'review_crash',
  'frequency',
  'escalating',
])

/** The kinds, as the notification settings name them */
export const KINDS: { kind: RouteKind; label: string }[] = [
  { kind: 'new', label: 'New issue' },
  { kind: 'threshold', label: 'Threshold reached' },
  { kind: 'frequency', label: 'Frequency reached' },
  { kind: 'escalating', label: 'Issue escalating' },
  { kind: 'regression', label: 'Regression' },
  { kind: 'ignore_expired', label: 'Ignore period ended' },
  { kind: 'review_crash', label: 'App Review or TestFlight crash' },
  { kind: 'monitor_down', label: 'Monitor down' },
  { kind: 'monitor_up', label: 'Monitor recovered' },
  { kind: 'slower_release', label: 'Slower release' },
  { kind: 'metric', label: 'Metric alert' },
  { kind: 'weekly', label: 'Weekly summary' },
]
export const LEVELS = ['fatal', 'error', 'warning', 'info', 'debug']

export type Notice = {
  kind: NoticeKind
  threshold?: number // set per route, from the thresholds it names that the count passed
  countBefore?: number // threshold notices: the issue's count before this event
  routeId?: number // frequency notices: the route whose limit was reached, the only one that takes it
  heldMore?: number // after quiet hours: how many more the channel held, sent with this, the newest
  // frequency: what reached the route's limit in its window; escalating: the events of the hour just ended
  rate?: { count: number; what: 'events' | 'users'; minutes: number }
  project: { id: number; slug: string; name: string }
  issue: { id: number; title: string; culprit: string; level: string; count: number }
  event: {
    release?: string
    environment?: string
    level: string
    device?: string
    os?: string
    tags?: Record<string, string> // the event's, for a route's tag filter
  }
  url: string // the issue in the dashboard
}

export type Route = {
  id: number
  project_id: number | null
  kinds: string // JSON
  levels: string | null
  environments: string | null
  thresholds: string
  channel_ids: string
  frequency?: string | null // JSON Frequency (src/notify/rules.ts)
  releases?: string | null // JSON list of globs
  query?: string | null // tag filters in search syntax
  interval_minutes?: number // wait before alerting again on the same issue; 0 for never
}

const list = (json: string | null): unknown[] | null => {
  if (json === null) return null
  try {
    const value = JSON.parse(json)
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** The thresholds an issue's count passed with this event: from `before` (excluded) to `after` (included) */
export const crossed = (thresholds: number[], before: number, after: number) =>
  thresholds.filter((t) => before < t && after >= t)

/** Whether a route takes this notice */
export function routeTakes(route: Route, notice: Notice): boolean {
  if (route.project_id !== null && route.project_id !== notice.project.id) return false
  const kind = routeKindOf(notice.kind)
  if (!list(route.kinds)?.includes(kind)) return false
  // A summary or a metric is of no one event: a route's levels and environments don't apply to it
  if (kind === 'weekly' || kind === 'metric') return true
  const levels = list(route.levels)
  if (levels && !levels.includes(notice.event.level)) return false
  const environments = list(route.environments)
  if (environments && !environments.includes(notice.event.environment ?? '')) return false
  if (notice.kind === 'threshold' && !thresholdFor(route, notice)) return false
  if (notice.kind === 'frequency' && notice.routeId !== route.id) return false
  if (ISSUE_KINDS.has(notice.kind) && !matchesFilters(route, notice.event)) return false
  return true
}

/** The highest of a route's thresholds the issue's count passed with this event, if any */
export function thresholdFor(route: Route, notice: Notice): number | undefined {
  const thresholds = (list(route.thresholds) ?? []).filter((t): t is number => typeof t === 'number')
  return crossed(thresholds, notice.countBefore ?? notice.issue.count, notice.issue.count).at(-1)
}

export const channelIds = (route: Route) =>
  (list(route.channel_ids) ?? []).filter((id): id is number => typeof id === 'number')

const MINUTES: Record<number, string> = { 60: 'an hour', 1440: 'a day' }
/** A window in words: 10 minutes, an hour, a day */
export const minutesText = (minutes: number) => MINUTES[minutes] ?? `${minutes} minutes`

/** A count and its noun, singular for 1: "1 event", "50 events", "10 users" */
export const counted = (n: number, noun: 'event' | 'user') => `${n} ${n === 1 ? noun : `${noun}s`}`

/** What happened, in a few words */
function whatOf(notice: Notice): string {
  switch (notice.kind) {
    case 'new':
      return 'New issue'
    case 'threshold':
      return `Reached ${counted(notice.threshold ?? notice.issue.count, 'event')}`
    case 'frequency':
      return notice.rate
        ? `${counted(notice.rate.count, notice.rate.what === 'users' ? 'user' : 'event')} in ${minutesText(notice.rate.minutes)}`
        : 'Frequency reached'
    case 'escalating':
      return `Escalating with ${counted(notice.rate?.count ?? notice.issue.count, 'event')} in the last hour`
    case 'regression':
      return `Regressed${notice.event.release ? ` in ${notice.event.release}` : ''}`
    case 'ignore_expired':
      return 'Ignore period ended'
    case 'monitor_up':
      return 'Recovered'
    case 'review_crash':
      return 'Crashed in App Review'
    default:
      // monitor_down, slower_release, weekly and the metric alerts say it in their culprit
      return notice.issue.culprit
  }
}

/** The line under the title: where and what */
export function noticeLine(notice: Notice): string {
  return [
    notice.project.name,
    notice.event.release,
    notice.event.device ?? notice.event.os,
    whatOf(notice),
    notice.heldMore && `${notice.heldMore} more arrived during quiet hours`,
  ]
    .filter(Boolean)
    .join(' · ')
}
