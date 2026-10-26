// Issues: the list (searched, sorted, with a sparkline each), one issue with its events, and what can be done to them.
import type { Priority } from '../ingest/priority'
import { issueFilter } from '../search/query'
import { scoped } from './charts'
import { lastDays } from './projects'

export const SORTS = {
  lastSeen: 'i.last_seen',
  firstSeen: 'i.first_seen',
  events: 'i.count',
  users: 'i.user_count',
  // High first, then the most recently seen of each
  priority: "CASE i.priority WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, i.last_seen",
}
export type Sort = keyof typeof SORTS
export const PAGE = 50

export type IssueRow = {
  id: number
  project_id: number
  title: string
  culprit: string
  type: string
  level: string
  platform: string
  status: 'unresolved' | 'resolved' | 'ignored'
  substatus: string | null
  resolved_in_release: string | null
  ignore_until_count: number | null
  ignore_until: number | null
  ignore_until_users: number | null
  priority: Priority
  count: number
  user_count: number
  first_seen: number
  last_seen: number
  first_release: string | null
  last_release: string | null
  last_event_id: string | null
  fixed_in_release: string | null
  resolved_in_commit: string | null
  assignee: string | null
  external_url: string | null
}

const marks = (n: number) => Array(n).fill('?').join(',')

async function seriesOf(db: D1Database, ids: number[], days: string[]) {
  if (!ids.length) return new Map<number, number[]>()
  const rows = (
    await db
      .prepare(`SELECT issue_id, day, count FROM issue_days WHERE day >= ? AND issue_id IN (${marks(ids.length)})`)
      .bind(days[0], ...ids)
      .all<{ issue_id: number; day: string; count: number }>()
  ).results
  return new Map(
    ids.map((id) => {
      const byDay = new Map(rows.filter((r) => r.issue_id === id).map((r) => [r.day, r.count]))
      return [id, days.map((d) => byDay.get(d) ?? 0)]
    }),
  )
}

export async function listIssues(
  db: D1Database,
  opts: { query: string; projectId?: number; sort: Sort; page: number },
  now: number,
) {
  // The chart over the list narrows the same way (`issueEventsByDay`), so the two agree
  const f = scoped(issueFilter(opts.query, now), opts.projectId)
  const where = f.where.length ? `WHERE ${f.where.join(' AND ')}` : ''
  // One more than a page, to know there's another
  const rows = (
    await db
      .prepare(
        `SELECT i.*, p.slug AS project FROM issues i JOIN projects p ON p.id = i.project_id ${where}
         ORDER BY ${SORTS[opts.sort]} DESC, i.id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...f.params, PAGE + 1, opts.page * PAGE)
      .all<IssueRow & { project: string }>()
  ).results
  const issues = rows.slice(0, PAGE)
  const series = await seriesOf(
    db,
    issues.map((i) => i.id),
    lastDays(14, now),
  )
  return { issues: issues.map((i) => ({ ...i, series: series.get(i.id)! })), more: rows.length > PAGE }
}

export type Activity = { id: number; kind: string; data: string | null; by: string | null; at: number }

// The images an attachment may be shown as, by its type or else its name; never SVG, which can carry script
const IMAGES: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** The image type an attachment is served as, or null when it only downloads */
export function attachmentType(filename: string, contentType: string | null): string | null {
  const byType = contentType?.toLowerCase().match(/^image\/(png|jpeg|gif|webp)$/)?.[1]
  return IMAGES[byType ?? filename.toLowerCase().split('.').at(-1) ?? ''] ?? null
}

export async function getIssue(db: D1Database, id: number, eventId: string | undefined, now: number) {
  const issue = await db
    .prepare(
      'SELECT i.*, p.slug AS project, p.name AS project_name FROM issues i JOIN projects p ON p.id = i.project_id WHERE i.id = ?',
    )
    .bind(id)
    .first<IssueRow & { project: string; project_name: string }>()
  if (!issue) return null
  const days = lastDays(90, now)
  const [tags, events, feedback, activity] = await db.batch<Record<string, unknown>>([
    // The top values of each tag, as Sentry's tag sidebar
    db
      .prepare(
        `SELECT key, value, count, total FROM (SELECT key, value, count,
           SUM(count) OVER (PARTITION BY key) AS total,
           ROW_NUMBER() OVER (PARTITION BY key ORDER BY count DESC) AS n
         FROM issue_tag_values WHERE issue_id = ?) WHERE n <= 5 ORDER BY key, count DESC`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT id, received, level, release, environment, message FROM events WHERE issue_id = ?
         ORDER BY received DESC LIMIT 100`,
      )
      .bind(id),
    db.prepare('SELECT id, name, message, event_id, at FROM feedback WHERE issue_id = ? ORDER BY at DESC').bind(id),
    db
      .prepare('SELECT id, kind, data, by, at FROM issue_activity WHERE issue_id = ? ORDER BY at DESC, id DESC')
      .bind(id),
  ])
  const list = events.results as {
    id: string
    received: number
    level: string
    release: string | null
    environment: string | null
    message: string
  }[]
  const chosen = eventId ?? list[0]?.id
  const row = chosen
    ? await db
        .prepare('SELECT id, data FROM events WHERE id = ? AND issue_id = ?')
        .bind(chosen, id)
        .first<{ id: string; data: string }>()
    : null
  const at = list.findIndex((e) => e.id === row?.id)
  const attachments = row
    ? (
        await db
          .prepare('SELECT id, filename, content_type, size FROM attachments WHERE event_id = ? ORDER BY id')
          .bind(row.id)
          .all<{ id: number; filename: string; content_type: string | null; size: number }>()
      ).results.map((a) => ({
        id: a.id,
        filename: a.filename,
        size: a.size,
        image: !!attachmentType(a.filename, a.content_type),
      }))
    : []
  return {
    issue,
    series: (await seriesOf(db, [id], days)).get(id)!,
    days,
    tags: tags.results as { key: string; value: string; count: number; total: number }[],
    events: list,
    // As JSON text: contexts and breadcrumbs are free-form, which server functions can't promise to serialise
    eventJson: row?.data ?? null,
    newer: at > 0 ? list[at - 1].id : undefined,
    older: at >= 0 && at < list.length - 1 ? list[at + 1].id : undefined,
    attachments,
    feedback: feedback.results as {
      id: number
      name: string | null
      message: string
      event_id: string | null
      at: number
    }[],
    activity: activity.results as Activity[],
    // The project's releases with events, newest first, for "Resolve in a release…"
    releases: (
      await db
        .prepare(
          `SELECT release FROM events WHERE project_id = ? AND release IS NOT NULL GROUP BY release
           ORDER BY MAX(received) DESC LIMIT 50`,
        )
        .bind(issue.project_id)
        .all<{ release: string }>()
    ).results.map((r) => r.release),
  }
}

export type IssueChange =
  | { action: 'resolve'; inRelease?: boolean; current?: boolean; release?: string }
  | { action: 'ignore'; forEvents?: number; forUsers?: number; until?: number; untilEscalating?: boolean }
  | { action: 'reopen' }
  | { action: 'delete'; discard?: boolean }
  | { action: 'priority'; priority: Priority }

/** Resolves, ignores, reopens or deletes issues; every change is written to each one's activity, with who did it */
export async function changeIssues(db: D1Database, ids: number[], change: IssueChange, by: string, now: number) {
  if (!ids.length) return
  if (change.action === 'delete') {
    const m = marks(ids.length)
    // Discarding keeps every fingerprint of the issues, merged ones too, so ingest drops their events from now on;
    // 40 issues a statement, as D1 binds 100 values at most
    const discard = change.discard
      ? Array.from({ length: Math.ceil(ids.length / 40) }, (_, i) => {
          const part = ids.slice(i * 40, i * 40 + 40)
          return db
            .prepare(
              `INSERT OR IGNORE INTO discarded_fingerprints (project_id, fingerprint, at)
               SELECT project_id, fingerprint, ?1 FROM issues WHERE id IN (${marks(part.length)})
               UNION SELECT project_id, fingerprint, ?1 FROM issue_fingerprints WHERE issue_id IN (${marks(part.length)})`,
            )
            .bind(now, ...part, ...part)
        })
      : []
    await db.batch([...discard, db.prepare(`DELETE FROM issues WHERE id IN (${m})`).bind(...ids)])
    return
  }
  const statements: D1PreparedStatement[] = []
  // "In the current release": each issue's latest release, named in its activity
  const latest =
    change.action === 'resolve' && change.current
      ? new Map(
          (
            await db
              .prepare(`SELECT id, last_release FROM issues WHERE id IN (${marks(ids.length)})`)
              .bind(...ids)
              .all<{ id: number; last_release: string | null }>()
          ).results.map((r) => [r.id, r.last_release]),
        )
      : undefined
  for (const id of ids) {
    let set: string
    let values: unknown[]
    let data: Record<string, unknown> = {}
    if (change.action === 'resolve') {
      // "In the next release": the release it's resolved against is the latest it was seen in; only another one reopens it
      // In a release, current or chosen: that release and newer ones reopen it (`fixed_in_release`, store.ts)
      const fixed = (change.current ? latest?.get(id) : change.release) ?? null
      set =
        "status = 'resolved', substatus = NULL, resolved_in_release = CASE WHEN ? THEN last_release END, fixed_in_release = ?, resolved_in_commit = NULL, ignore_until = NULL, ignore_until_count = NULL, ignore_until_users = NULL"
      values = [change.inRelease && !fixed ? 1 : 0, fixed]
      data = fixed ? { release: fixed } : { inRelease: !!change.inRelease }
    } else if (change.action === 'ignore') {
      // Until it escalates: only the hourly escalation check opens it again (src/data/escalation.ts)
      const kind = change.forEvents
        ? 'until_count'
        : change.forUsers
          ? 'until_users'
          : change.until
            ? 'until_date'
            : change.untilEscalating
              ? 'until_escalating'
              : 'for_good'
      set =
        "status = 'ignored', substatus = ?, ignore_until_count = CASE WHEN ? THEN count + ? END, ignore_until_users = CASE WHEN ? THEN user_count + ? END, ignore_until = ?, resolved_in_release = NULL, fixed_in_release = NULL, resolved_in_commit = NULL"
      values = [
        kind,
        change.forEvents ? 1 : 0,
        change.forEvents ?? 0,
        change.forUsers ? 1 : 0,
        change.forUsers ?? 0,
        change.until ?? null,
      ]
      data = {
        forEvents: change.forEvents ?? null,
        forUsers: change.forUsers ?? null,
        until: change.until ?? null,
        untilEscalating: kind === 'until_escalating',
      }
    } else if (change.action === 'priority') {
      set = 'priority = ?'
      values = [change.priority]
      data = { priority: change.priority }
    } else {
      set =
        "status = 'unresolved', substatus = 'ongoing', resolved_in_release = NULL, fixed_in_release = NULL, resolved_in_commit = NULL, ignore_until = NULL, ignore_until_count = NULL, ignore_until_users = NULL"
      values = []
    }
    const kind = { resolve: 'resolved', ignore: 'ignored', reopen: 'reopened', priority: 'priority' }[change.action]
    statements.push(
      db.prepare(`UPDATE issues SET ${set} WHERE id = ?`).bind(...values, id),
      db
        .prepare('INSERT INTO issue_activity (issue_id, kind, data, by, at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, kind, JSON.stringify(data), by, now),
    )
  }
  await db.batch(statements)
}

export const addNote = (db: D1Database, id: number, text: string, by: string, now: number) =>
  db
    .prepare("INSERT INTO issue_activity (issue_id, kind, data, by, at) VALUES (?, 'note', ?, ?, ?)")
    .bind(id, JSON.stringify({ text }), by, now)
    .run()

export const deleteNote = (db: D1Database, issueId: number, noteId: number, by: string) =>
  db
    .prepare("DELETE FROM issue_activity WHERE id = ? AND issue_id = ? AND kind = 'note' AND by = ?")
    .bind(noteId, issueId, by)
    .run()

/**
 * Merges issues into the first: their events, counts, days, tags, users and feedback move to it, and their
 * fingerprints send new events to it too. Only issues of one project merge.
 */
export async function mergeIssues(db: D1Database, ids: number[], by: string, now: number) {
  const [into, ...rest] = ids
  if (!rest.length) return
  const all = (
    await db
      .prepare(`SELECT id, project_id, fingerprint, title FROM issues WHERE id IN (${marks(ids.length)})`)
      .bind(...ids)
      .all<{ id: number; project_id: number; fingerprint: string; title: string }>()
  ).results
  const target = all.find((i) => i.id === into)
  const from = all.filter((i) => i.id !== into)
  if (!target || from.some((i) => i.project_id !== target.project_id))
    throw new Error('Only issues from the same project can be merged.')
  const m = marks(from.length)
  const fromIds = from.map((i) => i.id)
  await db.batch([
    db.prepare(`UPDATE events SET issue_id = ? WHERE issue_id IN (${m})`).bind(into, ...fromIds),
    db.prepare(`UPDATE feedback SET issue_id = ? WHERE issue_id IN (${m})`).bind(into, ...fromIds),
    db
      .prepare(
        `INSERT INTO event_hours (project_id, issue_id, hour, level, release, environment, count)
         SELECT project_id, ?, hour, level, release, environment, SUM(count) FROM event_hours WHERE issue_id IN (${m})
         GROUP BY project_id, hour, level, release, environment
         ON CONFLICT DO UPDATE SET count = count + excluded.count`,
      )
      .bind(into, ...fromIds),
    db
      .prepare(
        `INSERT INTO issue_days (issue_id, day, count) SELECT ?, day, SUM(count) FROM issue_days WHERE issue_id IN (${m}) GROUP BY day
         ON CONFLICT DO UPDATE SET count = count + excluded.count`,
      )
      .bind(into, ...fromIds),
    db
      .prepare(
        `INSERT INTO issue_tag_values (issue_id, key, value, count, last_seen)
         SELECT ?, key, value, SUM(count), MAX(last_seen) FROM issue_tag_values WHERE issue_id IN (${m}) GROUP BY key, value
         ON CONFLICT DO UPDATE SET count = count + excluded.count, last_seen = MAX(last_seen, excluded.last_seen)`,
      )
      .bind(into, ...fromIds),
    db
      .prepare(
        `INSERT OR IGNORE INTO issue_users (issue_id, user_hash) SELECT ?, user_hash FROM issue_users WHERE issue_id IN (${m})`,
      )
      .bind(into, ...fromIds),
    // Fingerprints merged into the merged issues come along
    db.prepare(`UPDATE issue_fingerprints SET issue_id = ? WHERE issue_id IN (${m})`).bind(into, ...fromIds),
    db
      .prepare(
        `INSERT OR REPLACE INTO issue_fingerprints (project_id, fingerprint, issue_id) SELECT project_id, fingerprint, ? FROM issues WHERE id IN (${m})`,
      )
      .bind(into, ...fromIds),
    db
      .prepare(
        `UPDATE issues SET
           count = count + (SELECT SUM(count) FROM issues WHERE id IN (${m})),
           first_seen = MIN(first_seen, (SELECT MIN(first_seen) FROM issues WHERE id IN (${m}))),
           last_seen = MAX(last_seen, (SELECT MAX(last_seen) FROM issues WHERE id IN (${m}))),
           user_count = (SELECT COUNT(*) FROM issue_users WHERE issue_id = ?)
         WHERE id = ?`,
      )
      .bind(...fromIds, ...fromIds, ...fromIds, into, into),
    db
      .prepare('INSERT INTO issue_activity (issue_id, kind, data, by, at) VALUES (?, ?, ?, ?, ?)')
      .bind(into, 'merged', JSON.stringify({ issues: from.map((i) => ({ id: i.id, title: i.title })) }), by, now),
    db.prepare(`DELETE FROM issues WHERE id IN (${m})`).bind(...fromIds),
  ])
}

/**
 * The hourly cron, at :20: unresolved issues of projects with "Resolve issues not seen for" N days, last seen before
 * then, resolved 100 at a time with an `auto_resolved` activity entry, until none are left or the deadline
 */
export async function autoResolve(db: D1Database, now: number, deadline = Date.now() + 20_000) {
  let total = 0
  while (Date.now() < deadline) {
    const { results } = await db
      .prepare(
        `SELECT i.id, p.auto_resolve_days AS days FROM issues i JOIN projects p ON p.id = i.project_id
         WHERE p.auto_resolve_days IS NOT NULL AND i.status = 'unresolved'
           AND i.last_seen < ? - p.auto_resolve_days * 86400000 LIMIT 100`,
      )
      .bind(now)
      .all<{ id: number; days: number }>()
    if (!results.length) break
    const ids = results.map((r) => r.id)
    await db.batch([
      db
        .prepare(
          `UPDATE issues SET status = 'resolved', substatus = NULL, resolved_in_release = NULL, ignore_until = NULL,
           ignore_until_count = NULL, ignore_until_users = NULL WHERE id IN (${ids.map(() => '?').join(',')})`,
        )
        .bind(...ids),
      ...results.map((r) =>
        db
          .prepare("INSERT INTO issue_activity (issue_id, kind, data, at) VALUES (?, 'auto_resolved', ?, ?)")
          .bind(r.id, JSON.stringify({ days: r.days }), now),
      ),
    ])
    total += ids.length
  }
  return total
}
