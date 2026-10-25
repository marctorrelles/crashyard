// Issues: the list (searched, sorted, with a sparkline each), one issue with its events, and what can be done to them.
import { issueFilter } from '../search/query'
import { lastDays } from './projects'

export const SORTS = { lastSeen: 'i.last_seen', firstSeen: 'i.first_seen', events: 'i.count', users: 'i.user_count' }
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
  count: number
  user_count: number
  first_seen: number
  last_seen: number
  first_release: string | null
  last_release: string | null
  last_event_id: string | null
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
  const f = issueFilter(opts.query, now)
  if (opts.projectId) {
    f.where.push('i.project_id = ?')
    f.params.push(opts.projectId)
  }
  if (f.projectSlugs.length) {
    f.where.push(`i.project_id IN (SELECT id FROM projects WHERE slug IN (${marks(f.projectSlugs.length)}))`)
    f.params.push(...f.projectSlugs)
  }
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
          .prepare('SELECT id, filename, content_type, size FROM attachments WHERE event_id = ?')
          .bind(row.id)
          .all<{ id: number; filename: string; content_type: string | null; size: number }>()
      ).results
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
  }
}

export type IssueChange =
  | { action: 'resolve'; inRelease?: boolean }
  | { action: 'ignore'; forEvents?: number; until?: number }
  | { action: 'reopen' }
  | { action: 'delete' }

/** Resolves, ignores, reopens or deletes issues; every change is written to each one's activity, with who did it */
export async function changeIssues(db: D1Database, ids: number[], change: IssueChange, by: string, now: number) {
  if (!ids.length) return
  if (change.action === 'delete') {
    await db
      .prepare(`DELETE FROM issues WHERE id IN (${marks(ids.length)})`)
      .bind(...ids)
      .run()
    return
  }
  const statements: D1PreparedStatement[] = []
  for (const id of ids) {
    let set: string
    let values: unknown[]
    let data: Record<string, unknown> = {}
    if (change.action === 'resolve') {
      // "In the next release": the release it's resolved against is the latest it was seen in; only another one reopens it
      set =
        "status = 'resolved', substatus = NULL, resolved_in_release = CASE WHEN ? THEN last_release END, ignore_until = NULL, ignore_until_count = NULL"
      values = [change.inRelease ? 1 : 0]
      data = { inRelease: !!change.inRelease }
    } else if (change.action === 'ignore') {
      const kind = change.forEvents ? 'until_count' : change.until ? 'until_date' : 'for_good'
      set =
        "status = 'ignored', substatus = ?, ignore_until_count = CASE WHEN ? THEN count + ? END, ignore_until = ?, resolved_in_release = NULL"
      values = [kind, change.forEvents ? 1 : 0, change.forEvents ?? 0, change.until ?? null]
      data = { forEvents: change.forEvents ?? null, until: change.until ?? null }
    } else {
      set =
        "status = 'unresolved', substatus = 'ongoing', resolved_in_release = NULL, ignore_until = NULL, ignore_until_count = NULL"
      values = []
    }
    const kind = { resolve: 'resolved', ignore: 'ignored', reopen: 'reopened' }[change.action]
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
    throw new Error('only issues of one project merge')
  const m = marks(from.length)
  const fromIds = from.map((i) => i.id)
  await db.batch([
    db.prepare(`UPDATE events SET issue_id = ? WHERE issue_id IN (${m})`).bind(into, ...fromIds),
    db.prepare(`UPDATE feedback SET issue_id = ? WHERE issue_id IN (${m})`).bind(into, ...fromIds),
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
