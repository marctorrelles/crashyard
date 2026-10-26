// What's worth telling someone about an issue, and which routes it goes through.

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

/** The kinds, as the notification settings name them */
export const KINDS: { kind: NoticeKind; label: string }[] = [
  { kind: 'new', label: 'New issue' },
  { kind: 'threshold', label: 'Threshold reached' },
  { kind: 'regression', label: 'Regression' },
  { kind: 'ignore_expired', label: 'Ignore period ended' },
  { kind: 'review_crash', label: 'App Review or TestFlight crash' },
  { kind: 'monitor_down', label: 'Monitor down' },
  { kind: 'monitor_up', label: 'Monitor recovered' },
  { kind: 'slower_release', label: 'Slower release' },
  { kind: 'weekly', label: 'Weekly summary' },
]
export const LEVELS = ['fatal', 'error', 'warning', 'info', 'debug']

export type Notice = {
  kind: NoticeKind
  threshold?: number // set per route, from the thresholds it names that the count passed
  countBefore?: number // threshold notices: the issue's count before this event
  project: { id: number; slug: string; name: string }
  issue: { id: number; title: string; culprit: string; level: string; count: number }
  event: { release?: string; environment?: string; level: string; device?: string; os?: string }
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
  if (!list(route.kinds)?.includes(notice.kind)) return false
  // A summary is of no one event: a route's levels and environments don't apply to it
  if (notice.kind === 'weekly') return true
  const levels = list(route.levels)
  if (levels && !levels.includes(notice.event.level)) return false
  const environments = list(route.environments)
  if (environments && !environments.includes(notice.event.environment ?? '')) return false
  if (notice.kind === 'threshold' && !thresholdFor(route, notice)) return false
  return true
}

/** The highest of a route's thresholds the issue's count passed with this event, if any */
export function thresholdFor(route: Route, notice: Notice): number | undefined {
  const thresholds = (list(route.thresholds) ?? []).filter((t): t is number => typeof t === 'number')
  return crossed(thresholds, notice.countBefore ?? notice.issue.count, notice.issue.count).at(-1)
}

export const channelIds = (route: Route) =>
  (list(route.channel_ids) ?? []).filter((id): id is number => typeof id === 'number')

/** The line under the title: where and what */
export function noticeLine(notice: Notice): string {
  const what =
    notice.kind === 'new'
      ? 'New issue'
      : notice.kind === 'threshold'
        ? `Reached ${notice.threshold} events`
        : notice.kind === 'regression'
          ? `Regressed${notice.event.release ? ` in ${notice.event.release}` : ''}`
          : notice.kind === 'ignore_expired'
            ? 'Ignore period ended'
            : notice.kind === 'monitor_down'
              ? notice.issue.culprit
              : notice.kind === 'monitor_up'
                ? 'Recovered'
                : notice.kind === 'slower_release' || notice.kind === 'weekly'
                  ? notice.issue.culprit
                  : 'Crashed in App Review'
  return [notice.project.name, notice.event.release, notice.event.device ?? notice.event.os, what]
    .filter(Boolean)
    .join(' · ')
}
