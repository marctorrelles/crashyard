// Releases: a project's releases from its events and sessions, their health (users, adoption, crash-free), their
// deploys, and what one changed against the one before (the release diff).

export type ReleaseRow = { release: string; events: number; issues: number; first: number; last: number }

const DAY = 864e5
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`)

// ponytail: read from events (kept 90 days) and sessions, so older releases drop off; a releases table comes with uploads (phase 5)
/** Releases with events or sessions, newest first by when they were first seen; a release with sessions alone has no issues */
export async function listReleases(db: D1Database, projectId: number) {
  const [events, sessions] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT release, COUNT(*) AS events, COUNT(DISTINCT issue_id) AS issues, MIN(received) AS first, MAX(received) AS last
         FROM events WHERE project_id = ? AND release IS NOT NULL GROUP BY release ORDER BY first DESC LIMIT 100`,
      )
      .bind(projectId),
    db
      .prepare(
        `SELECT release, MIN(day) AS first, MAX(day) AS last FROM sessions_daily WHERE project_id = ? AND release != ''
         GROUP BY release ORDER BY first DESC LIMIT 100`,
      )
      .bind(projectId),
  ])
  const rows = new Map((events.results as ReleaseRow[]).map((r) => [r.release, { ...r }]))
  for (const s of sessions.results as { release: string; first: string; last: string }[]) {
    // A session's day is all that's kept: its start stands for when
    const first = dayStart(s.first)
    const last = dayStart(s.last)
    const row = rows.get(s.release)
    if (row) {
      row.first = Math.min(row.first, first)
      row.last = Math.max(row.last, last)
    } else rows.set(s.release, { release: s.release, events: 0, issues: 0, first, last })
  }
  return [...rows.values()].sort((a, b) => b.first - a.first || (a.release < b.release ? 1 : -1)).slice(0, 100)
}

/** Adopted from 10% of the last 24 hours' sessions */
export const ADOPTED = 0.1
export type Stage = 'adopted' | 'low' | 'replaced'

/**
 * A release's stage: adopted from 10%; below it, replaced when a newer release has more of the sessions, else low
 * adoption. `newer` are the adoptions of the releases first seen after it.
 */
export function adoptionStage(adoption: number | null, newer: (number | null)[]): Stage | null {
  if (adoption === null) return null
  if (adoption >= ADOPTED) return 'adopted'
  return newer.some((n) => n !== null && n > adoption) ? 'replaced' : 'low'
}

export const crashFreeUsers = (u?: { users: number; crashed: number }) =>
  u && u.users ? 1 - u.crashed / u.users : null

export type Health = {
  sessions: number
  crashed: number
  users: number
  crashedUsers: number
  sessions24h: number
  users24h: number
  crashFree: number | null
  crashFreeUsers: number | null
  adoption: number | null
}

/**
 * Each release's sessions and users, all-time and in the last 24 hours (read as the UTC days it spans, today and
 * yesterday, as sessions are counted per day), and its adoption: its share of those sessions
 */
export async function releaseHealth(db: D1Database, projectId: number, now: number) {
  const since = dayOf(now - DAY)
  const [sessions, users, recent, recentUsers] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        'SELECT release, SUM(started) AS sessions, SUM(crashed) AS crashed FROM sessions_daily WHERE project_id = ? GROUP BY release',
      )
      .bind(projectId),
    db
      .prepare(
        `SELECT release, COUNT(DISTINCT did_hash) AS users, COUNT(DISTINCT CASE WHEN crashed = 1 THEN did_hash END) AS crashed
         FROM session_users_daily WHERE project_id = ? GROUP BY release`,
      )
      .bind(projectId),
    db
      .prepare(
        'SELECT release, SUM(started) AS sessions FROM sessions_daily WHERE project_id = ? AND day >= ? GROUP BY release',
      )
      .bind(projectId, since),
    db
      .prepare(
        'SELECT release, COUNT(DISTINCT did_hash) AS users FROM session_users_daily WHERE project_id = ? AND day >= ? GROUP BY release',
      )
      .bind(projectId, since),
  ])
  type Row = { release: string; sessions: number; crashed: number; users: number }
  const by = <T extends { release: string }>(rows: unknown[]) => new Map((rows as T[]).map((r) => [r.release, r]))
  const s = by<Row>(sessions.results)
  const u = by<Row>(users.results)
  const r = by<Row>(recent.results)
  const ru = by<Row>(recentUsers.results)
  const total24h = [...r.values()].reduce((a, x) => a + x.sessions, 0)
  const releases = new Set([...s.keys(), ...u.keys()])
  return new Map<string, Health>(
    [...releases].map((release) => {
      const sessions = s.get(release)?.sessions ?? 0
      const crashed = s.get(release)?.crashed ?? 0
      const users = u.get(release)?.users ?? 0
      const crashedUsers = u.get(release)?.crashed ?? 0
      const sessions24h = r.get(release)?.sessions ?? 0
      return [
        release,
        {
          sessions,
          crashed,
          users,
          crashedUsers,
          sessions24h,
          users24h: ru.get(release)?.users ?? 0,
          crashFree: sessions ? 1 - crashed / sessions : null,
          crashFreeUsers: crashFreeUsers({ users, crashed: crashedUsers }),
          adoption: total24h ? sessions24h / total24h : null,
        },
      ]
    }),
  )
}

/** A release's share of each UTC day's sessions over the last `days` days, oldest first; null on a day with none */
export async function adoptionByDay(db: D1Database, projectId: number, release: string, now: number, days = 30) {
  const list = Array.from({ length: days }, (_, i) => dayOf(now - (days - 1 - i) * DAY))
  const rows = (
    await db
      .prepare(
        `SELECT day, SUM(started) AS total, SUM(CASE WHEN release = ? THEN started ELSE 0 END) AS mine
         FROM sessions_daily WHERE project_id = ? AND day >= ? GROUP BY day`,
      )
      .bind(release, projectId, list[0])
      .all<{ day: string; total: number; mine: number }>()
  ).results
  const by = new Map(rows.map((r) => [r.day, r]))
  return list.map((day) => {
    const r = by.get(day)
    return { day, at: dayStart(day), adoption: r && r.total ? r.mine / r.total : null }
  })
}

export type Thresholds = { release_crash_free_min: number | null; release_new_issues_max: number | null }

/**
 * Healthy when every threshold the project sets holds: crash-free sessions at least its minimum, new issues at most
 * its maximum. Null when it sets none, or none can be judged yet (no sessions for the only one set)
 */
export function healthOf(t: Thresholds, release: { crashFree: number | null; newIssues: number }) {
  const failed: string[] = []
  let judged = false
  if (t.release_crash_free_min !== null && release.crashFree !== null) {
    judged = true
    if (release.crashFree < t.release_crash_free_min) failed.push('crash-free sessions')
  }
  if (t.release_new_issues_max !== null) {
    judged = true
    if (release.newIssues > t.release_new_issues_max) failed.push('new issues')
  }
  return judged ? { healthy: failed.length === 0, failed } : null
}

export type Deploy = {
  id: number
  environment: string
  name: string | null
  url: string | null
  started: number | null
  finished: number
}

export const deploysOf = async (db: D1Database, projectId: number, release: string) =>
  (
    await db
      .prepare(
        'SELECT id, environment, name, url, started, finished FROM deploys WHERE project_id = ? AND release = ? ORDER BY finished DESC LIMIT 50',
      )
      .bind(projectId, release)
      .all<Deploy>()
  ).results

/** A deploy from sentry-cli, for each project given; answers what Sentry's Deploy serializer does */
export async function storeDeploy(
  db: D1Database,
  projectIds: number[],
  release: string,
  d: { environment: string; name?: string; url?: string; started?: number; finished: number },
) {
  if (!projectIds.length) return
  await db.batch(
    projectIds.map((id) =>
      db
        .prepare(
          'INSERT INTO deploys (project_id, release, environment, name, url, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(id, release, d.environment, d.name ?? null, d.url ?? null, d.started ?? null, d.finished),
    ),
  )
}

type DiffIssue = { id: number; title: string; culprit: string; level: string; status: string; count: number }

/** New, regressed, still happening, and gone (seen in the release before, not in this one) */
export async function releaseDiff(db: D1Database, projectId: number, release: string) {
  const releases = await listReleases(db, projectId)
  const at = releases.findIndex((r) => r.release === release)
  if (at < 0) return null
  const previous = releases[at + 1]?.release ?? null
  const inRelease = (r: string) =>
    `EXISTS (SELECT 1 FROM issue_tag_values v WHERE v.issue_id = i.id AND v.key = 'release' AND v.value = ${r})`
  const cols = `i.id, i.title, i.culprit, i.level, i.status,
    (SELECT count FROM issue_tag_values v WHERE v.issue_id = i.id AND v.key = 'release' AND v.value = ?1) AS count`
  const [fresh, regressed, ongoing, gone] = await db.batch<DiffIssue>([
    db
      .prepare(`SELECT ${cols} FROM issues i WHERE i.project_id = ?2 AND i.first_release = ?1 ORDER BY count DESC`)
      .bind(release, projectId),
    db
      .prepare(
        `SELECT ${cols} FROM issues i WHERE i.project_id = ?2 AND i.id IN (SELECT issue_id FROM issue_activity
           WHERE kind = 'regressed' AND json_extract(data, '$.release') = ?1) ORDER BY count DESC`,
      )
      .bind(release, projectId),
    db
      .prepare(
        `SELECT ${cols} FROM issues i WHERE i.project_id = ?2 AND ${inRelease('?1')} AND i.first_release IS NOT ?1
           AND i.id NOT IN (SELECT issue_id FROM issue_activity WHERE kind = 'regressed' AND json_extract(data, '$.release') = ?1)
         ORDER BY count DESC LIMIT 50`,
      )
      .bind(release, projectId),
    db
      .prepare(
        `SELECT i.id, i.title, i.culprit, i.level, i.status,
           (SELECT count FROM issue_tag_values v WHERE v.issue_id = i.id AND v.key = 'release' AND v.value = ?3) AS count
         FROM issues i WHERE i.project_id = ?2 AND ${inRelease('?3')} AND NOT ${inRelease('?1')} ORDER BY count DESC LIMIT 50`,
      )
      .bind(release, projectId, previous),
  ])
  return {
    release: releases[at],
    previous,
    fresh: fresh.results,
    regressed: regressed.results,
    ongoing: ongoing.results,
    gone: previous ? gone.results : [],
  }
}
