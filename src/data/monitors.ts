// Monitors for the dashboard: the list with each one's recent history, one monitor with its check-ins, results and
// incidents, and making, changing, pausing and deleting them.
import { type CronConfig, dueAfter, type MonitorRow, type UptimeConfig } from '../monitors/monitors'
import { slugOf } from './projects'

export type Beat = { at: number; ok: number; status: string | null; ms: number | null }

export async function listMonitors(db: D1Database) {
  const monitors = (
    await db
      .prepare(
        `SELECT m.*, p.slug AS project, p.name AS project_name,
           (SELECT opened_at FROM incidents i WHERE i.monitor_id = m.id AND i.closed_at IS NULL) AS incident_since
         FROM monitors m JOIN projects p ON p.id = m.project_id ORDER BY m.status = 'failing' DESC, p.name, m.name`,
      )
      .all<MonitorRow & { project: string; project_name: string; incident_since: number | null }>()
  ).results
  if (!monitors.length) return []
  // The last 30 of each: uptime results, or check-ins
  const [uptime, checkins] = await db.batch<Beat & { monitor_id: number }>([
    db.prepare(
      `SELECT monitor_id, at, ok, CAST(status AS TEXT) AS status, ms FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY monitor_id ORDER BY at DESC) AS n FROM uptime_results) WHERE n <= 30`,
    ),
    db.prepare(
      `SELECT monitor_id, started AS at, status IN ('ok', 'in_progress') AS ok, status, duration AS ms FROM
         (SELECT *, ROW_NUMBER() OVER (PARTITION BY monitor_id ORDER BY started DESC) AS n FROM check_ins) WHERE n <= 30`,
    ),
  ])
  const beats = Map.groupBy([...uptime.results, ...checkins.results], (b) => b.monitor_id)
  return monitors.map((m) => ({ ...m, beats: (beats.get(m.id) ?? []).sort((a, b) => a.at - b.at) }))
}

export async function getMonitor(db: D1Database, id: number, now = Date.now()) {
  const monitor = await db
    .prepare(
      'SELECT m.*, p.slug AS project, p.name AS project_name FROM monitors m JOIN projects p ON p.id = m.project_id WHERE m.id = ?',
    )
    .bind(id)
    .first<MonitorRow & { project: string; project_name: string }>()
  if (!monitor) return null
  const DAY = 864e5
  const uptime = monitor.kind === 'uptime'
  // Over 24 hours, 7 and 30 days: the share of results that passed (uptime) or finished runs that were ok (cron)
  const shares = uptime
    ? db
        .prepare(
          `SELECT SUM(at >= ?2) AS n1, SUM(at >= ?2 AND ok) AS ok1, SUM(at >= ?3) AS n7, SUM(at >= ?3 AND ok) AS ok7,
             COUNT(*) AS n30, SUM(ok) AS ok30 FROM uptime_results WHERE monitor_id = ?1 AND at >= ?4`,
        )
        .bind(id, now - DAY, now - 7 * DAY, now - 30 * DAY)
    : db
        .prepare(
          `SELECT SUM(started >= ?2) AS n1, SUM(started >= ?2 AND status = 'ok') AS ok1, SUM(started >= ?3) AS n7,
             SUM(started >= ?3 AND status = 'ok') AS ok7, COUNT(*) AS n30, SUM(status = 'ok') AS ok30
           FROM check_ins WHERE monitor_id = ?1 AND started >= ?4 AND status != 'in_progress'`,
        )
        .bind(id, now - DAY, now - 7 * DAY, now - 30 * DAY)
  // Response times over 24 hours, by the hour; a job's durations over 30 days, by the day
  const times = uptime
    ? db
        .prepare('SELECT at, ms FROM uptime_results WHERE monitor_id = ? AND at >= ? AND ms IS NOT NULL')
        .bind(id, now - DAY)
    : db
        .prepare(
          'SELECT started AS at, duration AS ms FROM check_ins WHERE monitor_id = ? AND started >= ? AND duration IS NOT NULL',
        )
        .bind(id, now - 30 * DAY)
  const [results, checkins, incidents, share, timing, environments, errors] = await db.batch<Record<string, unknown>>([
    db
      .prepare('SELECT at, ok, status, ms, error FROM uptime_results WHERE monitor_id = ? ORDER BY at DESC LIMIT 120')
      .bind(id),
    db
      .prepare(
        'SELECT id, status, started, finished, duration, release, environment FROM check_ins WHERE monitor_id = ? ORDER BY started DESC LIMIT 60',
      )
      .bind(id),
    db
      .prepare(
        'SELECT id, opened_at, closed_at, reason FROM incidents WHERE monitor_id = ? ORDER BY opened_at DESC LIMIT 20',
      )
      .bind(id),
    shares,
    times,
    db
      .prepare(
        'SELECT environment, status, last_check_in FROM monitor_environments WHERE monitor_id = ? ORDER BY environment',
      )
      .bind(id),
    // Errors during this job: events that name the monitor (contexts.monitor.slug, as a tag) or share a check-in's trace
    db
      .prepare(
        `SELECT e.id, e.issue_id, e.received, e.level, i.title FROM events e JOIN issues i ON i.id = e.issue_id
         WHERE e.project_id = ?1 AND (e.id IN (SELECT event_id FROM event_tags WHERE project_id = ?1 AND key = 'monitor.slug' AND value = ?2)
           OR e.trace_id IN (SELECT trace_id FROM check_ins WHERE monitor_id = ?3 AND trace_id IS NOT NULL ORDER BY started DESC LIMIT 200))
         ORDER BY e.received DESC LIMIT 20`,
      )
      .bind(monitor.project_id, monitor.slug, id),
  ])
  const s = (share.results[0] ?? {}) as Record<string, number | null>
  const rate = (ok: number | null, n: number | null) => (n ? (ok ?? 0) / n : null)
  return {
    monitor,
    results: results.results as {
      at: number
      ok: number
      status: number | null
      ms: number | null
      error: string | null
    }[],
    checkins: checkins.results as {
      id: string
      status: string
      started: number
      finished: number | null
      duration: number | null
      release: string | null
      environment: string | null
    }[],
    incidents: incidents.results as { id: number; opened_at: number; closed_at: number | null; reason: string }[],
    uptime: { day: rate(s.ok1, s.n1), week: rate(s.ok7, s.n7), month: rate(s.ok30, s.n30) },
    p95: p95Series(timing.results as { at: number; ms: number }[], uptime ? HOUR : DAY, now, uptime ? 24 : 30),
    environments: environments.results as { environment: string; status: string; last_check_in: number }[],
    errors: errors.results as { id: string; issue_id: number; received: number; level: string; title: string }[],
    now,
  }
}

const HOUR = 36e5

/** The p95 (nearest rank) of each of the last `n` buckets of `size` up to `now`, oldest first; null where none */
export function p95Series(points: { at: number; ms: number }[], size: number, now: number, n: number) {
  const first = now - (now % size) - (n - 1) * size
  const by = Map.groupBy(
    points.filter((p) => p.at >= first),
    (p) => p.at - (p.at % size),
  )
  return Array.from({ length: n }, (_, i) => {
    const at = first + i * size
    const ms = (by.get(at) ?? []).map((p) => p.ms).sort((a, b) => a - b)
    return { at, p95: ms.length ? ms[Math.max(0, Math.ceil(ms.length * 0.95) - 1)] : null }
  })
}

export type MonitorInput = {
  id?: number
  project_id: number
  name: string
  slug?: string
  environment: string
  failure_threshold: number
  recovery_threshold: number
} & ({ kind: 'uptime'; config: UptimeConfig } | { kind: 'cron'; config: CronConfig })

export async function saveMonitor(db: D1Database, m: MonitorInput, now: number) {
  // An uptime check runs at once; a cron monitor waits for its first check-in from the next run on
  const nextDue = m.kind === 'uptime' ? now : dueAfter(m.config, now)
  if (m.id) {
    await db
      .prepare(
        `UPDATE monitors SET project_id = ?, name = ?, config = ?, environment = ?, failure_threshold = ?, recovery_threshold = ?,
           next_due = CASE WHEN status = 'paused' THEN next_due ELSE ? END WHERE id = ? AND kind = ?`,
      )
      .bind(
        m.project_id,
        m.name,
        JSON.stringify(m.config),
        m.environment,
        m.failure_threshold,
        m.recovery_threshold,
        nextDue,
        m.id,
        m.kind,
      )
      .run()
    return m.id
  }
  const row = await db
    .prepare(
      `INSERT INTO monitors (project_id, slug, name, kind, config, failure_threshold, recovery_threshold, next_due, environment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      m.project_id,
      m.slug || slugOf(m.name),
      m.name,
      m.kind,
      JSON.stringify(m.config),
      m.failure_threshold,
      m.recovery_threshold,
      nextDue,
      m.environment,
      now,
    )
    .first<{ id: number }>()
  return row!.id
}

export async function setPaused(db: D1Database, id: number, paused: boolean, now: number) {
  const m = await db
    .prepare('SELECT kind, config FROM monitors WHERE id = ?')
    .bind(id)
    .first<{ kind: string; config: string }>()
  if (!m) return
  const nextDue = m.kind === 'uptime' ? now : dueAfter(JSON.parse(m.config) as CronConfig, now)
  await db
    .prepare(
      paused
        ? "UPDATE monitors SET status = 'paused' WHERE id = ?"
        : "UPDATE monitors SET status = 'pending', failures = 0, successes = 0, muted_at = NULL, next_due = ? WHERE id = ?",
    )
    .bind(...(paused ? [id] : [nextDue, id]))
    .run()
}

export const deleteMonitor = (db: D1Database, id: number) =>
  db.prepare('DELETE FROM monitors WHERE id = ?').bind(id).run()

export const failingMonitors = async (db: D1Database) =>
  (
    await db
      .prepare(
        `SELECT m.id, m.name, p.name AS project, p.slug AS project_slug, (SELECT opened_at FROM incidents i WHERE i.monitor_id = m.id AND i.closed_at IS NULL) AS since,
           (SELECT reason FROM incidents i WHERE i.monitor_id = m.id AND i.closed_at IS NULL) AS reason
         FROM monitors m JOIN projects p ON p.id = m.project_id WHERE m.status = 'failing'`,
      )
      .all<{
        id: number
        name: string
        project: string
        project_slug: string
        since: number | null
        reason: string | null
      }>()
  ).results

/** Shows an uptime check on its project's status page, or takes it off */
export const setPublic = (db: D1Database, id: number, on: boolean) =>
  db
    .prepare("UPDATE monitors SET public = ? WHERE id = ? AND kind = 'uptime'")
    .bind(on ? 1 : 0, id)
    .run()

const DAY = 86_400_000

/**
 * A project's public status page: its uptime checks shown on it, each with its state, its days up over the last 30
 * (UTC) and its incidents then. Only what the page shows leaves here: names and times, never a URL, config or why a
 * check failed. Null when the project has none shown, the same as when there's no such project.
 */
export async function statusPage(db: D1Database, slug: string, now: number) {
  const project = await db
    .prepare('SELECT id, name FROM projects WHERE slug = ?')
    .bind(slug)
    .first<{ id: number; name: string }>()
  if (!project) return null
  const since = Math.floor(now / DAY) * DAY - 29 * DAY
  const [checks, days, incidents] = await db.batch<Record<string, number | string | null>>([
    db
      .prepare(
        "SELECT id, name, status FROM monitors WHERE project_id = ? AND public = 1 AND kind = 'uptime' ORDER BY name",
      )
      .bind(project.id),
    db
      .prepare(
        `SELECT r.monitor_id, r.at / ${DAY} AS day, SUM(r.ok) AS up, COUNT(*) AS checks
         FROM uptime_results r JOIN monitors m ON m.id = r.monitor_id
         WHERE m.project_id = ? AND m.public = 1 AND m.kind = 'uptime' AND r.at >= ? GROUP BY r.monitor_id, day`,
      )
      .bind(project.id, since),
    db
      .prepare(
        `SELECT i.monitor_id, i.opened_at, i.closed_at FROM incidents i JOIN monitors m ON m.id = i.monitor_id
         WHERE m.project_id = ? AND m.public = 1 AND m.kind = 'uptime' AND (i.closed_at IS NULL OR i.closed_at >= ?)
         ORDER BY i.opened_at DESC LIMIT 50`,
      )
      .bind(project.id, since),
  ])
  if (!checks.results.length) return null
  const nameOf = new Map(checks.results.map((c) => [c.id as number, c.name as string]))
  return {
    name: project.name,
    now,
    checks: checks.results.map((c) => {
      const mine = days.results.filter((d) => d.monitor_id === c.id)
      const up = mine.reduce((n, d) => n + (d.up as number), 0)
      const all = mine.reduce((n, d) => n + (d.checks as number), 0)
      return {
        name: c.name as string,
        status: c.status as 'pending' | 'ok' | 'failing' | 'paused',
        uptime: all ? up / all : null,
        // The last 30 UTC days, oldest first: the share of checks that passed, null for a day without any
        days: Array.from({ length: 30 }, (_, i) => {
          const d = mine.find((r) => r.day === since / DAY + i)
          return { at: since + i * DAY, up: d ? (d.up as number) / (d.checks as number) : null }
        }),
      }
    }),
    incidents: incidents.results.map((i) => ({
      check: nameOf.get(i.monitor_id as number)!,
      opened: i.opened_at as number,
      closed: i.closed_at as number | null,
    })),
  }
}
