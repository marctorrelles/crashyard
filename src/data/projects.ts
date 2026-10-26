// Projects: what the home page lists and charts, and creating, changing and deleting one.
import { topWithOther } from './charts'

export const PLATFORMS = ['apple', 'android', 'javascript', 'node', 'other'] as const
export type Platform = (typeof PLATFORMS)[number]

export type ProjectRow = {
  id: number
  slug: string
  name: string
  platform: Platform
  public_key: string
  daily_event_quota: number
  event_retention_days: number
  daily_log_quota: number
  log_retention_days: number
  created_at: number
}

export const dsnOf = (origin: string, p: Pick<ProjectRow, 'id' | 'public_key'>) => {
  const url = new URL(origin)
  return `${url.protocol}//${p.public_key}@${url.host}/${p.id}`
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
/** The last `n` days, oldest first, as 'YYYY-MM-DD' */
export const lastDays = (n: number, now: number) => Array.from({ length: n }, (_, i) => day(now - (n - 1 - i) * 864e5))

const newKey = () =>
  [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')

export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .slice(0, 40) || 'project'

export async function overview(db: D1Database, now: number) {
  const days = lastDays(14, now)
  const [projects, unresolved, counts, fresh] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT id, slug, name, platform FROM projects ORDER BY name'),
    db.prepare("SELECT project_id, COUNT(*) AS n FROM issues WHERE status = 'unresolved' GROUP BY project_id"),
    db.prepare('SELECT project_id, day, events FROM project_days WHERE day >= ?').bind(days[0]),
    db
      .prepare(
        `SELECT i.id, i.title, i.culprit, i.level, i.count, i.first_seen, p.slug AS project FROM issues i
         JOIN projects p ON p.id = i.project_id WHERE i.first_seen >= ? ORDER BY i.first_seen DESC LIMIT 10`,
      )
      .bind(now - 864e5),
  ])
  const open = new Map(unresolved.results.map((r) => [r.project_id as number, r.n as number]))
  return {
    projects: (projects.results as Pick<ProjectRow, 'id' | 'slug' | 'name' | 'platform'>[]).map((p) => {
      const byDay = new Map(
        counts.results.filter((c) => c.project_id === p.id).map((c) => [c.day as string, c.events as number]),
      )
      const series = days.map((d) => byDay.get(d) ?? 0)
      return { ...p, unresolved: open.get(p.id) ?? 0, series, today: series.at(-1)! + series.at(-2)! }
    }),
    newIssues: fresh.results as {
      id: number
      title: string
      culprit: string
      level: string
      count: number
      first_seen: number
      project: string
    }[],
  }
}

/**
 * The overview's charts over the last 30 UTC days (of every project, or of `projectIds`): events per day of the 8
 * projects with the most and the rest as one, issues first seen and issues resolved per day (and how many first seen in
 * the last 24 hours), and the crash-free sessions of each project's two newest releases (by their first session, in
 * the last 90 days).
 */
export async function overviewCharts(db: D1Database, projectIds: number[] | undefined, now: number) {
  const days = lastDays(30, now)
  const since = Date.parse(`${days[0]}T00:00:00Z`)
  const ids = projectIds ?? []
  const only = (column: string) => (projectIds ? ` AND ${column} IN (${ids.map(() => '?').join(',')})` : '')
  const [events, fresh, resolved, sessions] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT p.slug, p.name, d.day, d.events FROM project_days d JOIN projects p ON p.id = d.project_id
         WHERE d.day >= ?${only('d.project_id')}`,
      )
      .bind(days[0], ...ids),
    db
      .prepare(
        `SELECT date(first_seen / 1000, 'unixepoch') AS day, COUNT(*) AS n, SUM(first_seen >= ?) AS recent FROM issues
         WHERE first_seen >= ?${only('project_id')} GROUP BY day`,
      )
      .bind(now - 864e5, since, ...ids),
    db
      .prepare(
        `SELECT date(a.at / 1000, 'unixepoch') AS day, COUNT(DISTINCT a.issue_id) AS n FROM issue_activity a
         ${projectIds ? 'JOIN issues i ON i.id = a.issue_id ' : ''}WHERE a.kind = 'resolved' AND a.at >= ?${only('i.project_id')} GROUP BY day`,
      )
      .bind(since, ...ids),
    db
      .prepare(
        `SELECT p.slug AS project, s.release, s.started, s.crashed FROM (
           SELECT project_id, release, SUM(started) AS started, SUM(crashed) AS crashed,
             ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY MIN(day) DESC, release DESC) AS r
           FROM sessions_daily WHERE day >= ? AND release != ''${only('project_id')} GROUP BY project_id, release) s
         JOIN projects p ON p.id = s.project_id WHERE s.r <= 2 AND s.started > 0 ORDER BY p.name, s.r`,
      )
      .bind(day(now - 90 * 864e5), ...ids),
  ])
  const index = new Map(days.map((d, i) => [d, i]))
  const perDay = (rows: Record<string, unknown>[]) => {
    const counts = days.map(() => 0)
    for (const r of rows) {
      const i = index.get(r.day as string)
      if (i !== undefined) counts[i] += r.n as number
    }
    return counts
  }
  const byProject = new Map<string, { value: string; name: string; counts: number[] }>()
  for (const r of events.results as { slug: string; name: string; day: string; events: number }[]) {
    const i = index.get(r.day)
    if (i === undefined) continue
    let p = byProject.get(r.slug)
    if (!p) byProject.set(r.slug, (p = { value: r.slug, name: r.name, counts: days.map(() => 0) }))
    p.counts[i] += r.events
  }
  return {
    days,
    events: topWithOther([...byProject.values()], 8).map((s) => ({
      project: s.value,
      name: s.value === null ? 'Other projects' : byProject.get(s.value)!.name,
      counts: s.counts,
    })),
    newIssues: perDay(fresh.results),
    newRecent: fresh.results.reduce((a, r) => a + (r.recent as number), 0),
    resolved: perDay(resolved.results),
    crashFree: (sessions.results as { project: string; release: string; started: number; crashed: number }[]).map(
      (s) => ({ project: s.project, release: s.release, value: 1 - s.crashed / s.started }),
    ),
  }
}

export const projectBySlug = (db: D1Database, slug: string) =>
  db.prepare('SELECT * FROM projects WHERE slug = ?').bind(slug).first<ProjectRow>()

export const allProjects = async (db: D1Database) =>
  (
    await db
      .prepare('SELECT id, slug, name, platform FROM projects ORDER BY name')
      .all<Pick<ProjectRow, 'id' | 'slug' | 'name' | 'platform'>>()
  ).results

export async function createProject(db: D1Database, name: string, platform: Platform, now: number) {
  const base = slugOf(name)
  const taken = new Set(
    (
      await db
        .prepare("SELECT slug FROM projects WHERE slug = ? OR slug LIKE ? || '-%'")
        .bind(base, base)
        .all<{ slug: string }>()
    ).results.map((r) => r.slug),
  )
  let slug = base
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
  return (await db
    .prepare('INSERT INTO projects (slug, name, platform, public_key, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *')
    .bind(slug, name, platform, newKey(), now)
    .first<ProjectRow>())!
}

export async function updateProject(
  db: D1Database,
  id: number,
  change: Pick<
    ProjectRow,
    'name' | 'platform' | 'daily_event_quota' | 'event_retention_days' | 'daily_log_quota' | 'log_retention_days'
  >,
) {
  await db
    .prepare(
      `UPDATE projects SET name = ?, platform = ?, daily_event_quota = ?, event_retention_days = ?, daily_log_quota = ?,
       log_retention_days = ? WHERE id = ?`,
    )
    .bind(
      change.name,
      change.platform,
      change.daily_event_quota,
      change.event_retention_days,
      change.daily_log_quota,
      change.log_retention_days,
      id,
    )
    .run()
}

/** A new key: apps with the old DSN stop being heard (within a minute: ingest caches projects that long) */
export const rotateKey = (db: D1Database, id: number) =>
  db.prepare('UPDATE projects SET public_key = ? WHERE id = ?').bind(newKey(), id).run()

/** Deletes the project with its issues and events (foreign keys cascade); its raw envelopes expire from R2 */
export const deleteProject = (db: D1Database, id: number) =>
  db.prepare('DELETE FROM projects WHERE id = ?').bind(id).run()

/** The daily cron: events past their project's retention. Issues and their daily counts stay */
export async function pruneEvents(db: D1Database, now: number) {
  await db
    .prepare(
      `DELETE FROM events WHERE rowid IN (SELECT e.rowid FROM events e JOIN projects p ON p.id = e.project_id
       WHERE e.received < ? - p.event_retention_days * 86400000 LIMIT 5000)`,
    )
    .bind(now)
    .run()
}
