// What's worth telling someone about an issue, and which routes it goes through.

export type NoticeKind = 'new' | 'threshold' | 'regression' | 'ignore_expired' | 'review_crash'

export type Notice = {
  kind: NoticeKind
  threshold?: number // set per route, from the thresholds it names that the count passed
  countBefore?: number // threshold notices: the issue's count before this event
  project: { id: number; slug: string; name: string }
  issue: { id: number; title: string; culprit: string; level: string; count: number }
  event: { release?: string; environment?: string; level: string; device?: string; os?: string }
  url: string // the issue in the dashboard
  actions?: { resolve: string; ignore: string } // signed links the push's buttons call
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
      ? 'new'
      : notice.kind === 'threshold'
        ? `now ${notice.threshold}`
        : notice.kind === 'regression'
          ? `back${notice.event.release ? ` in ${notice.event.release}` : ''}`
          : notice.kind === 'ignore_expired'
            ? 'ignore ended'
            : 'App Review crash'
  return [notice.project.name, notice.event.release, notice.event.device ?? notice.event.os, what]
    .filter(Boolean)
    .join(' · ')
}
