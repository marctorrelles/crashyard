// Escalation: an issue whose last hour is well past anything in its week before. Hourly at :25, from `event_hours`.
import type { Notice } from '../notify/notice'

const HOUR = 3_600_000
/** Events in the hour below which an issue never escalates */
export const MIN_EVENTS = 10
/** How many times its busiest hour of the week before the last hour must be */
export const FACTOR = 2
/** Hours of history an hour is weighed against */
export const HISTORY = 7 * 24
/** An issue this young is still new: its new-issue alert said enough */
const YOUNG = 24 * HOUR
/** Escalating issues go back to ongoing after a week without escalating again */
const ESCALATING_FOR = 7 * 24 * HOUR
const BATCH = 50

/**
 * Whether the last of `hours` (events per hour, oldest first: the week before, then the hour just ended) escalates:
 * at least 10 events, and more than twice the busiest hour before it. Steady traffic, however busy, doesn't.
 */
export function escalating(hours: number[]): boolean {
  const last = hours.at(-1) ?? 0
  if (last < MIN_EVENTS) return false
  return last > FACTOR * Math.max(0, ...hours.slice(0, -1))
}

type Candidate = {
  id: number
  project_id: number
  slug: string
  name: string
  title: string
  culprit: string
  level: string
  count: number
  status: string
  n: number
}

/**
 * The hour just ended: issues with 10 events or more in it, unresolved and not escalating already, or ignored until
 * they escalate, are weighed against their week before. Those that escalate get substatus `escalating` (an ignored
 * one opens again), an `escalating` activity entry and an `escalating` notice. Escalating issues that haven't
 * escalated again in a week go back to ongoing. 50 issues a batch, until the deadline.
 */
export async function checkEscalation(db: D1Database, origin: string, now: number, deadline = Date.now() + 20_000) {
  const hour = now - (now % HOUR) - HOUR
  await db
    .prepare(
      `UPDATE issues SET substatus = 'ongoing' WHERE status = 'unresolved' AND substatus = 'escalating'
       AND id NOT IN (SELECT issue_id FROM issue_activity WHERE kind = 'escalating' AND at >= ?)`,
    )
    .bind(now - ESCALATING_FOR)
    .run()
  const candidates = (
    await db
      .prepare(
        `SELECT i.id, i.project_id, p.slug, p.name, i.title, i.culprit, i.level, i.count, i.status, h.n
         FROM (SELECT issue_id, SUM(count) AS n FROM event_hours WHERE hour = ? GROUP BY issue_id HAVING n >= ?) h
         JOIN issues i ON i.id = h.issue_id JOIN projects p ON p.id = i.project_id
         WHERE i.first_seen < ? AND ((i.status = 'unresolved' AND IFNULL(i.substatus, '') != 'escalating')
           OR (i.status = 'ignored' AND i.substatus = 'until_escalating'))
         ORDER BY h.n DESC LIMIT 500`,
      )
      .bind(hour, MIN_EVENTS, now - YOUNG)
      .all<Candidate>()
  ).results
  const notices: Notice[] = []
  for (let i = 0; i < candidates.length && Date.now() < deadline; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH)
    const ids = batch.map((c) => c.id)
    const marks = ids.map(() => '?').join(',')
    const [history, top] = await db.batch<{ issue_id: number; hour: number; n: number } & Record<string, unknown>>([
      db
        .prepare(
          `SELECT issue_id, hour, SUM(count) AS n FROM event_hours WHERE issue_id IN (${marks}) AND hour >= ? AND hour < ?
           GROUP BY issue_id, hour`,
        )
        .bind(...ids, hour - HISTORY * HOUR, hour),
      // Where most of the hour's events came from, for the alert's line and the routes' filters
      db
        .prepare(
          `SELECT issue_id, release, environment, level FROM (SELECT issue_id, release, environment, level,
             ROW_NUMBER() OVER (PARTITION BY issue_id ORDER BY SUM(count) DESC) AS r
           FROM event_hours WHERE issue_id IN (${marks}) AND hour = ? GROUP BY issue_id, release, environment, level)
           WHERE r = 1`,
        )
        .bind(...ids, hour),
    ])
    const byIssue = Map.groupBy(history.results, (r) => r.issue_id)
    const tops = new Map(
      (top.results as unknown as { issue_id: number; release: string; environment: string; level: string }[]).map(
        (t) => [t.issue_id, t],
      ),
    )
    const escalated = batch.filter((c) => {
      const counts = new Map((byIssue.get(c.id) ?? []).map((r) => [r.hour, r.n]))
      const hours = Array.from({ length: HISTORY }, (_, k) => counts.get(hour - (HISTORY - k) * HOUR) ?? 0)
      return escalating([...hours, c.n])
    })
    if (!escalated.length) continue
    const marked = escalated.map(() => '?').join(',')
    await db.batch([
      db
        .prepare(
          `UPDATE issues SET status = 'unresolved', substatus = 'escalating', ignore_until = NULL,
           ignore_until_count = NULL, ignore_until_users = NULL WHERE id IN (${marked})`,
        )
        .bind(...escalated.map((c) => c.id)),
      ...escalated.map((c) =>
        db
          .prepare("INSERT INTO issue_activity (issue_id, kind, data, at) VALUES (?, 'escalating', ?, ?)")
          .bind(c.id, JSON.stringify({ count: c.n, hour, wasIgnored: c.status === 'ignored' }), now),
      ),
    ])
    for (const c of escalated) {
      const t = tops.get(c.id)
      notices.push({
        kind: 'escalating',
        rate: { count: c.n, what: 'events', minutes: 60 },
        project: { id: c.project_id, slug: c.slug, name: c.name },
        issue: { id: c.id, title: c.title, culprit: c.culprit, level: c.level, count: c.count },
        event: {
          release: t?.release || undefined,
          environment: t?.environment || undefined,
          level: t?.level ?? c.level,
        },
        url: `${origin}/issues/${c.id}`,
      })
    }
  }
  return notices
}
