// Projects: what the home page lists and charts, and creating, changing and deleting one.
import { deleteDebugFile } from './tokens'
import type { Notice } from '../notify/notice'
import { topWithOther } from './charts'
import { projectDefaults } from './settings'

export type ProjectRow = {
  id: number
  slug: string
  name: string
  public_key: string // its first key; ingest reads project_keys
  daily_event_quota: number
  event_retention_days: number
  daily_log_quota: number
  log_retention_days: number
  action_retention_days: number
  debug_file_retention_days: number // debug files and source maps unused this long go, the newest kept (pruneUploads)
  daily_transaction_quota: number
  repo_url: string | null // where its code is, for stacks and commits to link to (`source.ts`)
  auto_resolve_days: number | null // resolve issues not seen for this many days; null is off
  priorities: string | null // JSON, a new issue's priority by level; null for PRIORITY_BY_LEVEL
  grouping_rules: string | null // fingerprint and stack trace rules (src/ingest/rules.ts)
  grouping_version: number
  filters: string | null // JSON, inbound filters (src/ingest/filters.ts)
  release_crash_free_min: number | null // release health: crash-free sessions at least this fraction; null is none
  release_new_issues_max: number | null // release health: at most this many new issues; null is none
  workers: string | null // JSON, Cloudflare Workers whose failed runs come in through tail() (src/api/tail.ts)
  worker_exceptions: number // 1: their uncaught exceptions too, for Workers without the Sentry SDK
  forward_dsn: string | null // a Sentry DSN every envelope goes on to (src/ingest/forward.ts)
  created_at: number
}

export const dsnOf = (origin: string, projectId: number, publicKey: string) => {
  const url = new URL(origin)
  return `${url.protocol}//${publicKey}@${url.host}/${projectId}`
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
  const [projects, unresolved, counts, fresh, recent] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT id, slug, name FROM projects ORDER BY name'),
    db.prepare("SELECT project_id, COUNT(*) AS n FROM issues WHERE status = 'unresolved' GROUP BY project_id"),
    db.prepare('SELECT project_id, day, events FROM project_days WHERE day >= ?').bind(days[0]),
    db
      .prepare(
        `SELECT i.id, i.title, i.culprit, i.level, i.count, i.first_seen, p.slug AS project FROM issues i
         JOIN projects p ON p.id = i.project_id WHERE i.first_seen >= ? ORDER BY i.first_seen DESC LIMIT 10`,
      )
      .bind(now - 864e5),
    // Sessions of the last 24 hours (today and yesterday, UTC) per release, with when each release was first seen
    db
      .prepare(
        `SELECT s.project_id, s.release, SUM(s.started) AS n,
           (SELECT MIN(f.day) FROM sessions_daily f WHERE f.project_id = s.project_id AND f.release = s.release) AS first
         FROM sessions_daily s WHERE s.day >= ? GROUP BY s.project_id, s.release`,
      )
      .bind(days.at(-2)),
  ])
  const open = new Map(unresolved.results.map((r) => [r.project_id as number, r.n as number]))
  const sessions = Map.groupBy(
    recent.results as { project_id: number; release: string; n: number; first: string }[],
    (r) => r.project_id,
  )
  // The newest release with sessions in the last 24 hours, and its share of them
  const newest = (id: number) => {
    const rows = sessions.get(id) ?? []
    const total = rows.reduce((a, r) => a + r.n, 0)
    const named = rows.filter((r) => r.release)
    if (!total || !named.length) return null
    const r = named.reduce((a, b) => (b.first > a.first || (b.first === a.first && b.release > a.release) ? b : a))
    return { release: r.release, adoption: r.n / total }
  }
  return {
    projects: (projects.results as Pick<ProjectRow, 'id' | 'slug' | 'name'>[]).map((p) => {
      const byDay = new Map(
        counts.results.filter((c) => c.project_id === p.id).map((c) => [c.day as string, c.events as number]),
      )
      const series = days.map((d) => byDay.get(d) ?? 0)
      return {
        ...p,
        unresolved: open.get(p.id) ?? 0,
        series,
        today: series.at(-1)! + series.at(-2)!,
        newest: newest(p.id),
      }
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
 * The overview's charts over the last `n` UTC days, 30 by default (of every project, or of `projectIds`): events per day of the 8
 * projects with the most and the rest as one, issues first seen and issues resolved per day (and how many first seen in
 * the last 24 hours), and the crash-free sessions of each project's two newest releases (by their first session, in
 * the last 90 days).
 */
export async function overviewCharts(db: D1Database, projectIds: number[] | undefined, now: number, n = 30) {
  const days = lastDays(n, now)
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

/** The Workers whose runs reach tail(), newest run first, each with the projects watching it */
export async function seenWorkers(db: D1Database) {
  const [seen, watched] = await db.batch<{ value: string; slug?: string; workers?: string }>([
    db.prepare("SELECT value FROM settings WHERE key = 'tail.workers'"),
    db.prepare('SELECT slug, workers FROM projects WHERE workers IS NOT NULL ORDER BY slug'),
  ])
  const at = JSON.parse(seen.results[0]?.value ?? '{}') as Record<string, number>
  const projects = watched.results.map((p) => ({ slug: p.slug!, workers: JSON.parse(p.workers!) as string[] }))
  return Object.entries(at)
    .sort((a, b) => b[1] - a[1])
    .map(([name, lastRun]) => ({
      name,
      lastRun,
      projects: projects.filter((p) => p.workers.includes(name)).map((p) => p.slug),
    }))
}

export const projectBySlug = (db: D1Database, slug: string) =>
  db.prepare('SELECT * FROM projects WHERE slug = ?').bind(slug).first<ProjectRow>()

/** Events and transactions a project's filters dropped in the last `days` UTC days, today's included */
export const filteredSince = async (db: D1Database, projectId: number, days: number, now: number) =>
  (
    await db
      .prepare('SELECT COALESCE(SUM(filtered), 0) AS n FROM project_days WHERE project_id = ? AND day >= ?')
      .bind(projectId, day(now - (days - 1) * 86_400_000))
      .first<{ n: number }>()
  )?.n ?? 0

export const allProjects = async (db: D1Database) =>
  (
    await db
      .prepare('SELECT id, slug, name FROM projects ORDER BY name')
      .all<Pick<ProjectRow, 'id' | 'slug' | 'name'>>()
  ).results

export async function createProject(db: D1Database, name: string, now: number) {
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
  const d = await projectDefaults(db)
  // Its first key, in project_keys too, by the trigger of migration 0013
  return (await db
    .prepare(
      `INSERT INTO projects (slug, name, public_key, daily_event_quota, daily_log_quota, daily_transaction_quota,
         event_retention_days, log_retention_days, action_retention_days, debug_file_retention_days, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(
      slug,
      name,
      newKey(),
      d.daily_event_quota,
      d.daily_log_quota,
      d.daily_transaction_quota,
      d.event_retention_days,
      d.log_retention_days,
      d.action_retention_days,
      d.debug_file_retention_days,
      now,
    )
    .first<ProjectRow>())!
}

/** What a project's settings pages change, each page its own fields */
export const PROJECT_FIELDS = [
  'name',
  'slug',
  'daily_event_quota',
  'event_retention_days',
  'daily_log_quota',
  'log_retention_days',
  'action_retention_days',
  'debug_file_retention_days',
  'daily_transaction_quota',
  'repo_url',
  'auto_resolve_days',
  'priorities',
  'grouping_rules',
  'release_crash_free_min',
  'release_new_issues_max',
  'filters',
  'workers',
  'worker_exceptions',
  'forward_dsn',
] as const
export type ProjectChange = Partial<Pick<ProjectRow, (typeof PROJECT_FIELDS)[number]>>

/** Only the fields given change; a slug another project has is refused */
export async function updateProject(db: D1Database, id: number, change: ProjectChange) {
  const fields = PROJECT_FIELDS.filter((f) => change[f] !== undefined)
  if (!fields.length) return
  if (change.slug !== undefined) {
    const taken = await db.prepare('SELECT 1 FROM projects WHERE slug = ? AND id != ?').bind(change.slug, id).first()
    if (taken) throw new Error('Another project has that slug. Pick a different one.')
  }
  await db
    .prepare(`UPDATE projects SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
    .bind(...fields.map((f) => change[f]), id)
    .run()
}

export type KeyRow = {
  id: number
  public_key: string
  label: string
  enabled: number
  daily_limit: number | null
  created_at: number
  today: number // events it sent today, UTC
}

/** A project's client keys, oldest first, with the events each sent today */
export const keysOf = async (db: D1Database, projectId: number, now: number) =>
  (
    await db
      .prepare(
        `SELECT k.id, k.public_key, k.label, k.enabled, k.daily_limit, k.created_at, COALESCE(d.events, 0) AS today
         FROM project_keys k LEFT JOIN key_days d ON d.key_id = k.id AND d.day = ? WHERE k.project_id = ? ORDER BY k.id`,
      )
      .bind(day(now), projectId)
      .all<KeyRow>()
  ).results

export const createKey = (db: D1Database, projectId: number, label: string, now: number) =>
  db
    .prepare('INSERT INTO project_keys (project_id, public_key, label, created_at) VALUES (?, ?, ?, ?)')
    .bind(projectId, newKey(), label, now)
    .run()

/** A key's label, switch and daily limit (null: none). Ingest caches keys a minute, so a change takes that long */
export const updateKey = (
  db: D1Database,
  projectId: number,
  id: number,
  change: { label: string; enabled: boolean; daily_limit: number | null },
) =>
  db
    .prepare('UPDATE project_keys SET label = ?, enabled = ?, daily_limit = ? WHERE id = ? AND project_id = ?')
    .bind(change.label, change.enabled ? 1 : 0, change.daily_limit, id, projectId)
    .run()

/** Deletes the project with its issues and events (foreign keys cascade); its raw envelopes expire from R2 */
/**
 * Deletes a project with everything of it. Its biggest tables go first, a batch at a time (one cascading delete of
 * millions of logs runs past D1's limit for a statement and undoes itself every time), then its files in R2, then the
 * project, whose cascade is small by then. Out of time first, it throws, and deleting again goes on from there
 */
export async function deleteProject(db: D1Database, files: R2Bucket, id: number, deadline = Date.now() + PRUNE_BUDGET) {
  const project = await db.prepare('SELECT name FROM projects WHERE id = ?').bind(id).first<{ name: string }>()
  if (!project) return
  const batches = (sql: string) => inBatches(deadline, async () => changes(await db.prepare(sql).bind(id).run()))
  await batches('DELETE FROM logs WHERE rowid IN (SELECT rowid FROM logs WHERE project_id = ? LIMIT 1000)')
  await batches('DELETE FROM actions WHERE id IN (SELECT id FROM actions WHERE project_id = ? LIMIT 1000)')
  await batches('DELETE FROM events WHERE rowid IN (SELECT rowid FROM events WHERE project_id = ? LIMIT 1000)')
  await batches('DELETE FROM issues WHERE id IN (SELECT id FROM issues WHERE project_id = ? LIMIT 100)')
  // Debug files one by one, as their files in R2 may be another row's too (a fat binary's archs share one)
  await inBatches(deadline, async () => {
    const { results } = await db
      .prepare('SELECT id FROM debug_files WHERE project_id = ? LIMIT 100')
      .bind(id)
      .all<{ id: number }>()
    for (const r of results) await deleteDebugFile(db, files, id, r.id)
    return results.length
  })
  for (const prefix of ['attachments', 'envelopes', 'pending', 'failed'])
    await inBatches(deadline, async () => {
      const { objects } = await files.list({ prefix: `${prefix}/${id}/`, limit: 1000 })
      if (objects.length) await files.delete(objects.map((o) => o.key))
      return objects.length
    })
  if (Date.now() >= deadline)
    throw new Error(`${project.name} has a lot stored, and only part of it is deleted. Delete it again to go on.`)
  await db.prepare('DELETE FROM projects WHERE id = ?').bind(id).run()
}

/** What the hourly prune may take, all of it together, in wall-clock ms */
export const PRUNE_BUDGET = 20_000

/** A delete run batch after batch until one deletes nothing or the deadline passes; how many rows went */
export async function inBatches(deadline: number, step: () => Promise<number>) {
  let total = 0
  while (Date.now() < deadline) {
    const n = await step()
    total += n
    if (!n) break
  }
  return total
}

const changes = (r: D1Result) => r.meta.changes ?? 0

/**
 * The hourly cron: events past their project's retention, then attachments past it (rows and R2 objects), then issues
 * last seen before it, with everything of theirs (days, tags, users, activity, fingerprints: foreign keys cascade),
 * each in batches until done or the deadline. Issues go 100 at a time, as each takes its rows with it
 */
export async function pruneEvents(db: D1Database, now: number, files?: R2Bucket, deadline = Date.now() + PRUNE_BUDGET) {
  const events = await inBatches(deadline, async () =>
    changes(
      await db
        .prepare(
          `DELETE FROM events WHERE rowid IN (SELECT e.rowid FROM events e JOIN projects p ON p.id = e.project_id
           WHERE e.received < ? - p.event_retention_days * 86400000 LIMIT 1000)`,
        )
        .bind(now)
        .run(),
    ),
  )
  const attachments = await inBatches(deadline, async () => {
    const { results } = await db
      .prepare(
        `SELECT a.id, a.r2_key FROM attachments a JOIN projects p ON p.id = a.project_id
         WHERE a.received < ? - p.event_retention_days * 86400000 LIMIT 1000`,
      )
      .bind(now)
      .all<{ id: number; r2_key: string }>()
    if (!results.length) return 0
    await files?.delete(results.map((r) => r.r2_key))
    await db
      .prepare('DELETE FROM attachments WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(results.map((r) => r.id)))
      .run()
    return results.length
  })
  const issues = await inBatches(deadline, async () =>
    changes(
      await db
        .prepare(
          `DELETE FROM issues WHERE id IN (SELECT i.id FROM issues i JOIN projects p ON p.id = i.project_id
           WHERE i.last_seen < ? - p.event_retention_days * 86400000 LIMIT 100)`,
        )
        .bind(now)
        .run(),
    ),
  )
  // Events per hour, kept as long as the events (escalation reads 7 days, metric alerts a day)
  const hours = await inBatches(deadline, async () =>
    changes(
      await db
        .prepare(
          `DELETE FROM event_hours WHERE (issue_id, hour, level, release, environment) IN (
             SELECT h.issue_id, h.hour, h.level, h.release, h.environment FROM event_hours h
             JOIN projects p ON p.id = h.project_id WHERE h.hour < ? - p.event_retention_days * 86400000 - 3600000 LIMIT 1000)`,
        )
        .bind(now)
        .run(),
    ),
  )
  // Events per minute, for frequency routes, whose windows are a day at most
  const minutes = await inBatches(deadline, async () =>
    changes(
      await db
        .prepare(
          `DELETE FROM issue_minutes WHERE (issue_id, minute) IN (
             SELECT issue_id, minute FROM issue_minutes WHERE minute < ? LIMIT 1000)`,
        )
        .bind(Math.floor((now - 86_400_000) / 60_000))
        .run(),
    ),
  )
  // Session users per day, kept as long as the events
  const sessionUsers = await inBatches(deadline, async () =>
    changes(
      await db
        .prepare(
          `DELETE FROM session_users_daily WHERE (project_id, release, environment, day, did_hash) IN (
             SELECT s.project_id, s.release, s.environment, s.day, s.did_hash FROM session_users_daily s
             JOIN projects p ON p.id = s.project_id
             WHERE s.day < strftime('%Y-%m-%d', (? - p.event_retention_days * 86400000) / 1000, 'unixepoch') LIMIT 1000)`,
        )
        .bind(now)
        .run(),
    ),
  )
  // Crashed sessions' ids, only needed while the SDK may send the same session again
  const sessionCrashes = await inBatches(deadline, async () =>
    changes(
      await db
        .prepare(
          `DELETE FROM session_crashes WHERE (project_id, sid) IN (
             SELECT project_id, sid FROM session_crashes WHERE at < ? LIMIT 1000)`,
        )
        .bind(now - 2 * 86_400_000)
        .run(),
    ),
  )
  return { events, attachments, issues, hours, minutes, sessionUsers, sessionCrashes }
}

/**
 * Monday's summary of the week before (the 7 UTC days to yesterday), one notice per project that had events in it or
 * the week before: its events against that week's, new issues, the issue with the most, and its newest release's
 * crash-free sessions in the week
 */
export async function weeklySummaries(db: D1Database, origin: string, now: number): Promise<Notice[]> {
  const days = lastDays(15, now).slice(0, 14) // two weeks to yesterday
  const [week, before] = [days.slice(7), days.slice(0, 7)]
  const start = Date.parse(week[0])
  const [totals, fresh, top, sessions] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT p.id, p.slug, p.name, SUM(CASE WHEN d.day >= ?1 THEN d.events ELSE 0 END) AS events,
           SUM(CASE WHEN d.day < ?1 THEN d.events ELSE 0 END) AS before
         FROM projects p JOIN project_days d ON d.project_id = p.id WHERE d.day BETWEEN ?2 AND ?3
         GROUP BY p.id HAVING SUM(d.events) > 0 ORDER BY p.name`,
      )
      .bind(week[0], before[0], week.at(-1)),
    db
      .prepare('SELECT project_id, COUNT(*) AS n FROM issues WHERE first_seen >= ? AND first_seen < ? GROUP BY 1')
      .bind(start, start + 7 * 864e5),
    // Each project's issue with the most events in the week
    db
      .prepare(
        `SELECT project_id, title, n FROM (SELECT i.project_id, i.title, SUM(d.count) AS n,
           ROW_NUMBER() OVER (PARTITION BY i.project_id ORDER BY SUM(d.count) DESC) AS r
         FROM issue_days d JOIN issues i ON i.id = d.issue_id WHERE d.day BETWEEN ? AND ? GROUP BY i.id) WHERE r = 1`,
      )
      .bind(week[0], week.at(-1)),
    // Each project's newest release with sessions in the week (by its first day of them)
    db
      .prepare(
        `SELECT project_id, release, started, crashed FROM (SELECT project_id, release, SUM(started) AS started,
           SUM(crashed) AS crashed, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY MIN(day) DESC, release DESC) AS r
         FROM sessions_daily WHERE day BETWEEN ? AND ? GROUP BY project_id, release) WHERE r = 1`,
      )
      .bind(week[0], week.at(-1)),
  ])
  const by = <T extends { project_id: number }>(rows: unknown[]) => new Map((rows as T[]).map((r) => [r.project_id, r]))
  const freshBy = by<{ project_id: number; n: number }>(fresh.results)
  const topBy = by<{ project_id: number; title: string; n: number }>(top.results)
  const sessionsBy = by<{ project_id: number; release: string; started: number; crashed: number }>(sessions.results)
  return (totals.results as { id: number; slug: string; name: string; events: number; before: number }[]).map((p) => {
    const change = p.before ? Math.round(((p.events - p.before) / p.before) * 100) : null
    const s = sessionsBy.get(p.id)
    const t = topBy.get(p.id)
    const n = freshBy.get(p.id)?.n ?? 0
    return {
      kind: 'weekly',
      project: { id: p.id, slug: p.slug, name: p.name },
      issue: {
        id: 0,
        title: `${p.events} event${p.events === 1 ? '' : 's'} last week${
          change === null
            ? ''
            : change === 0
              ? ', the same as the week before'
              : `, ${change > 0 ? 'up' : 'down'} ${Math.abs(change)}% on the week before`
        }`,
        culprit: [
          `${n} new issue${n === 1 ? '' : 's'}`,
          t && `Top issue: ${t.title.slice(0, 80)}, ${t.n} event${t.n === 1 ? '' : 's'}`,
          s?.started &&
            `${(Math.floor((1 - s.crashed / s.started) * 1000) / 10).toFixed(1)}% crash-free sessions in ${s.release}`,
        ]
          .filter(Boolean)
          .join(' · '),
        level: 'info',
        count: p.events,
      },
      event: { level: 'info' },
      url: `${origin}/?project=${encodeURIComponent(p.slug)}`,
    } satisfies Notice
  })
}

/** R2 deletes up to 1000 keys a call */
const R2_DELETE_MAX = 1000
async function deleteKeys(files: R2Bucket, keys: string[]) {
  for (let i = 0; i < keys.length; i += R2_DELETE_MAX) await files.delete(keys.slice(i, i + R2_DELETE_MAX))
}

/**
 * The hourly cron, with retention: debug files and artifact bundles uploaded and last read by a lookup (`markUsed`,
 * src/symbols/symbolicate.ts) more than their project's `debug_file_retention_days` ago, rows and R2 objects, until
 * done or the deadline. Debug files go by upload, the rows sharing a `created_at` (one assemble; a file sent again
 * moves into the new one, `files/difs/assemble`), and an upload stays while any of its rows is recent, used, or the
 * newest of its project, kind, name and arch (ProGuard mappings carry their UUID in the name: any mapping). So a
 * build is never gone while a part of it is current: a macOS build's arm64 slice stays beside its x86_64 one though an
 * iOS build of the same name came after, and a dSYM beside the binary uploaded with it whichever of the two lookups
 * read. A bundle only once a newer bundle of another release of the same package (`caliu-web` of `caliu-web@1.2`; a
 * release without `@` or none is one package) came after it. So an app's current build reads its stacks even before
 * its first crash. Stacks already symbolicated keep their names
 */
export async function pruneUploads(db: D1Database, files: R2Bucket, now: number, deadline = Date.now() + PRUNE_BUDGET) {
  // Every row once, a few thousand: cheaper than a correlated lookup of the newer ones for each
  const { results: rows } = await db
    .prepare(
      `SELECT d.id, d.project_id, d.kind, d.name, d.arch, d.file_key, d.symcache_key, d.created_at, d.last_used_at,
         ?1 - p.debug_file_retention_days * 86400000 AS cutoff
       FROM debug_files d JOIN projects p ON p.id = d.project_id`,
    )
    .bind(now)
    .all<{
      id: number
      project_id: number
      kind: string
      name: string
      arch: string | null
      file_key: string
      symcache_key: string | null
      created_at: number
      last_used_at: number | null
      cutoff: number
    }>()
  const slot = (r: (typeof rows)[number]) =>
    JSON.stringify([r.project_id, r.kind, r.arch, r.kind === 'proguard' ? '' : r.name])
  const newest = new Map<string, number>()
  for (const r of rows) newest.set(slot(r), Math.max(newest.get(slot(r)) ?? 0, r.created_at))
  const upload = (r: (typeof rows)[number]) => `${r.project_id}:${r.created_at}`
  const kept = new Set(
    rows
      .filter(
        (r) => r.created_at >= r.cutoff || (r.last_used_at ?? 0) >= r.cutoff || newest.get(slot(r)) === r.created_at,
      )
      .map(upload),
  )
  const gone = rows.filter((r) => !kept.has(upload(r)))
  // Up to two keys a row (the file, its SymCache or ProguardCache), so one R2 delete a batch
  let debugFiles = 0
  for (let i = 0; i < gone.length && Date.now() < deadline; i += 500) {
    const batch = gone.slice(i, i + 500)
    const keys = [...new Set(batch.flatMap((r) => [r.file_key, r.symcache_key ?? []].flat()))]
    // The rows first, each unless sent again since (its created_at moved), then what no row names any more: the
    // archs of one fat binary share its file
    const [deleted, still] = await db.batch<{ k: string }>([
      db
        .prepare(
          `DELETE FROM debug_files WHERE (id, created_at) IN (SELECT value ->> 0, value ->> 1 FROM json_each(?))
           RETURNING id AS k`,
        )
        .bind(JSON.stringify(batch.map((r) => [r.id, r.created_at]))),
      db
        .prepare(
          `SELECT file_key AS k FROM debug_files WHERE file_key IN (SELECT value FROM json_each(?1))
           UNION SELECT symcache_key FROM debug_files WHERE symcache_key IN (SELECT value FROM json_each(?1))`,
        )
        .bind(JSON.stringify(keys)),
    ])
    const named = new Set(still.results.map((r) => r.k))
    await deleteKeys(
      files,
      keys.filter((k) => !named.has(k)),
    )
    debugFiles += deleted.results.length
  }
  // A bundle's keys all name its checksum (`bundles/<checksum>`, `smcaches/<checksum>`, before 0035 one
  // `smcaches/<checksum>/<file>` a file), shared by every project it went to: kept while another row has the checksum
  const bundles = await inBatches(deadline, async () => {
    const { results } = await db
      .prepare(
        `SELECT b.id, b.checksum, b.file_key FROM artifact_bundles b JOIN projects p ON p.id = b.project_id
         WHERE MAX(b.created_at, COALESCE(b.last_used_at, 0)) < ?1 - p.debug_file_retention_days * 86400000
         AND EXISTS (SELECT 1 FROM artifact_bundles n WHERE n.project_id = b.project_id
           AND ${pkg('n')} = ${pkg('b')} AND n.created_at > b.created_at
           AND (b.release IS NULL OR n.release IS NOT b.release))
         LIMIT 50`,
      )
      .bind(now)
      .all<{ id: number; checksum: string; file_key: string }>()
    if (!results.length) return 0
    const ids = JSON.stringify(results.map((r) => r.id))
    const [caches, , still] = await db.batch<{ k: string; bundle_id: number }>([
      db
        .prepare(
          'SELECT DISTINCT bundle_id, cache_key AS k FROM artifact_files WHERE bundle_id IN (SELECT value FROM json_each(?)) AND cache_key IS NOT NULL',
        )
        .bind(ids),
      // Its files go with it, by cascade
      db.prepare('DELETE FROM artifact_bundles WHERE id IN (SELECT value FROM json_each(?))').bind(ids),
      db
        .prepare(
          'SELECT DISTINCT checksum AS k FROM artifact_bundles WHERE checksum IN (SELECT value FROM json_each(?))',
        )
        .bind(JSON.stringify(results.map((r) => r.checksum))),
    ])
    const kept = new Set(still.results.map((r) => r.k))
    const gone = new Set(results.filter((r) => !kept.has(r.checksum)).map((r) => r.id))
    const keys = new Set(results.filter((r) => gone.has(r.id)).map((r) => r.file_key))
    for (const c of caches.results) if (gone.has(c.bundle_id)) keys.add(c.k)
    await deleteKeys(files, [...keys])
    return results.length
  })
  return { debugFiles, bundles }
}

/** A bundle's package, the part of its release before `@`; '' for a release without one, or none */
const pkg = (t: string) =>
  `CASE WHEN instr(${t}.release, '@') > 0 THEN substr(${t}.release, 1, instr(${t}.release, '@') - 1) ELSE '' END`
