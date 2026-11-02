// Product analytics for the dashboard: actions (src/ingest/actions.ts) counted over a period, one action's breakdowns,
// a funnel and weekly retention. Actions and events hash their user alike, so each of these says which users also
// hit an error: the drop-off after a funnel step with a crash in between, retention with and without one.
const HOUR = 3_600_000
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/** A chart's step for a period: an hour in a day, 6 hours in a week, a day beyond */
const stepOf = (days: number) => (days <= 1 ? HOUR : days <= 7 ? 6 * HOUR : DAY)

function stepsOf(since: number, now: number, step: number) {
  const first = since - (since % step)
  return Array.from({ length: Math.floor((now - first) / step) + 1 }, (_, i) => first + i * step)
}

const change = (now: number, before: number) => (before > 0 ? now / before - 1 : null)

/**
 * A project's actions over a period: active users, actions and users who hit an error, each against the period
 * before; active users and actions per step; every action by count with its users, a trend and its change
 */
export async function summary(db: D1Database, projectId: number, days: number, now: number) {
  const span = days * DAY
  const since = now - span
  const step = stepOf(days)
  const steps = stepsOf(since, now, step)
  const [totals, before, byName, byNameBefore, byStep, byNameStep, withErrors] = await db.batch<
    Record<string, number | string>
  >([
    db
      .prepare(
        'SELECT COUNT(*) AS actions, COUNT(DISTINCT user_hash) AS users FROM actions WHERE project_id = ? AND timestamp >= ?',
      )
      .bind(projectId, since),
    db
      .prepare(
        'SELECT COUNT(*) AS actions, COUNT(DISTINCT user_hash) AS users FROM actions WHERE project_id = ? AND timestamp >= ? AND timestamp < ?',
      )
      .bind(projectId, since - span, since),
    db
      .prepare(
        'SELECT name, COUNT(*) AS count, COUNT(DISTINCT user_hash) AS users FROM actions WHERE project_id = ? AND timestamp >= ? GROUP BY name ORDER BY count DESC LIMIT 50',
      )
      .bind(projectId, since),
    db
      .prepare(
        'SELECT name, COUNT(*) AS count FROM actions WHERE project_id = ? AND timestamp >= ? AND timestamp < ? GROUP BY name',
      )
      .bind(projectId, since - span, since),
    db
      .prepare(
        'SELECT timestamp - timestamp % ? AS at, COUNT(*) AS actions, COUNT(DISTINCT user_hash) AS users FROM actions WHERE project_id = ? AND timestamp >= ? GROUP BY at',
      )
      .bind(step, projectId, steps[0]),
    db
      .prepare(
        'SELECT name, timestamp - timestamp % ? AS at, COUNT(*) AS count FROM actions WHERE project_id = ? AND timestamp >= ? GROUP BY name, at',
      )
      .bind(step, projectId, steps[0]),
    db
      .prepare(
        `SELECT COUNT(DISTINCT user_hash) AS users FROM actions WHERE project_id = ? AND timestamp >= ?
           AND user_hash IN (SELECT user_hash FROM events WHERE project_id = ? AND timestamp >= ? AND user_hash IS NOT NULL)`,
      )
      .bind(projectId, since, projectId, since),
  ])
  const t = totals.results[0] as { actions: number; users: number }
  const b = before.results[0] as { actions: number; users: number }
  const stepRows = new Map((byStep.results as { at: number; actions: number; users: number }[]).map((r) => [r.at, r]))
  const previous = new Map((byNameBefore.results as { name: string; count: number }[]).map((r) => [r.name, r.count]))
  const trends = new Map<string, Map<number, number>>()
  for (const r of byNameStep.results as { name: string; at: number; count: number }[]) {
    const m = trends.get(r.name) ?? new Map<number, number>()
    m.set(r.at, r.count)
    trends.set(r.name, m)
  }
  const erred = (withErrors.results[0] as { users: number }).users
  return {
    users: t.users,
    usersChange: change(t.users, b.users),
    actions: t.actions,
    actionsChange: change(t.actions, b.actions),
    perUser: t.users ? t.actions / t.users : null,
    withErrors: t.users ? erred / t.users : null,
    steps,
    activeUsers: steps.map((at) => stepRows.get(at)?.users ?? 0),
    actionsPerStep: steps.map((at) => stepRows.get(at)?.actions ?? 0),
    list: (byName.results as { name: string; count: number; users: number }[]).map((r) => ({
      ...r,
      change: change(r.count, previous.get(r.name) ?? 0),
      trend: steps.map((at) => trends.get(r.name)?.get(at) ?? 0),
    })),
  }
}

/** The action names a project has had in the last 90 days, most frequent first, for the funnel's steps */
export async function actionNames(db: D1Database, projectId: number, now: number) {
  return (
    await db
      .prepare(
        'SELECT name FROM actions WHERE project_id = ? AND timestamp >= ? GROUP BY name ORDER BY COUNT(*) DESC LIMIT 100',
      )
      .bind(projectId, now - 90 * DAY)
      .all<{ name: string }>()
  ).results.map((r) => r.name)
}

/**
 * One action over a period: count and users per step, its properties (the keys seen) and the values of `by` (the
 * first key when none), by release, and the issues whose events shared a trace with it
 */
export async function action(db: D1Database, projectId: number, name: string, days: number, now: number, by?: string) {
  const since = now - days * DAY
  const step = stepOf(days)
  const steps = stepsOf(since, now, step)
  const [perStep, keys, releases, issues] = await db.batch<Record<string, number | string>>([
    db
      .prepare(
        'SELECT timestamp - timestamp % ? AS at, COUNT(*) AS count, COUNT(DISTINCT user_hash) AS users FROM actions WHERE project_id = ? AND name = ? AND timestamp >= ? GROUP BY at',
      )
      .bind(step, projectId, name, steps[0]),
    db
      .prepare(
        'SELECT p.key AS key, COUNT(*) AS count FROM actions, json_each(actions.properties) AS p WHERE project_id = ? AND name = ? AND timestamp >= ? GROUP BY p.key ORDER BY count DESC LIMIT 20',
      )
      .bind(projectId, name, since),
    db
      .prepare(
        "SELECT COALESCE(release, '') AS value, COUNT(*) AS count, COUNT(DISTINCT user_hash) AS users FROM actions WHERE project_id = ? AND name = ? AND timestamp >= ? GROUP BY value ORDER BY count DESC LIMIT 10",
      )
      .bind(projectId, name, since),
    db
      .prepare(
        `SELECT i.id AS id, i.title AS title, i.level AS level, COUNT(DISTINCT a.trace_id) AS traces
           FROM actions a JOIN events e ON e.trace_id = a.trace_id JOIN issues i ON i.id = e.issue_id
          WHERE a.project_id = ? AND a.name = ? AND a.timestamp >= ? AND a.trace_id IS NOT NULL
          GROUP BY i.id ORDER BY traces DESC LIMIT 5`,
      )
      .bind(projectId, name, since),
  ])
  const keyList = (keys.results as { key: string; count: number }[]).map((k) => k.key)
  const key = by && keyList.includes(by) ? by : keyList[0]
  const values = key
    ? (
        await db
          .prepare(
            "SELECT CAST(json_extract(properties, '$.' || json_quote(?)) AS TEXT) AS value, COUNT(*) AS count FROM actions WHERE project_id = ? AND name = ? AND timestamp >= ? GROUP BY value ORDER BY count DESC LIMIT 10",
          )
          .bind(key, projectId, name, since)
          .all<{ value: string | null; count: number }>()
      ).results.map((v) => ({ value: v.value ?? '(none)', count: v.count }))
    : []
  const rows = new Map((perStep.results as { at: number; count: number; users: number }[]).map((r) => [r.at, r]))
  const counts = steps.map((at) => rows.get(at)?.count ?? 0)
  return {
    steps,
    counts,
    users: steps.map((at) => rows.get(at)?.users ?? 0),
    total: counts.reduce((a, b) => a + b, 0),
    keys: keyList,
    by: key,
    values,
    releases: releases.results as { value: string; count: number; users: number }[],
    issues: issues.results as { id: number; title: string; level: string; traces: number }[],
  }
}

/** How long after a step the next one counts for a funnel */
export const FUNNEL_WINDOW = DAY

type Hit = { user: string; at: number }

/**
 * A funnel: of the users who did the first step in the period, how many did each next one in order, each within a
 * day of the step before. Of those who stopped at a step, how many hit an error before the next would have been due,
 * and the issues they hit most.
 */
export async function funnel(db: D1Database, projectId: number, names: string[], days: number, now: number) {
  const since = now - days * DAY
  const marks = names.map(() => '?').join(', ')
  const rows = (
    await db
      .prepare(
        `SELECT user_hash AS user, name, timestamp AS at FROM actions
          WHERE project_id = ? AND timestamp >= ? AND name IN (${marks}) AND user_hash IS NOT NULL
          ORDER BY user_hash, timestamp LIMIT 200000`,
      )
      .bind(projectId, since, ...names)
      .all<{ user: string; name: string; at: number }>()
  ).results
  // Each user's way through: the time they reached each step, in order
  const reached: Hit[][] = names.map(() => [])
  for (const [user, own] of Map.groupBy(rows, (r) => r.user)) {
    let step = 0
    let last = 0
    for (const r of own) {
      if (r.name !== names[step]) continue
      if (step > 0 && r.at - last > FUNNEL_WINDOW) continue
      reached[step].push({ user, at: r.at })
      last = r.at
      if (++step === names.length) break
    }
  }
  // Errors of the users who stopped somewhere, in the period and the window after it
  const stopped = new Set(
    reached
      .slice(0, -1)
      .flatMap((hits) => hits.map((h) => h.user))
      .filter(Boolean),
  )
  const errors = stopped.size
    ? (
        await db
          .prepare(
            `SELECT e.user_hash AS user, e.issue_id AS issue, e.timestamp AS at FROM events e
              WHERE e.project_id = ? AND e.timestamp >= ? AND e.user_hash IS NOT NULL LIMIT 100000`,
          )
          .bind(projectId, since)
          .all<{ user: string; issue: number; at: number }>()
      ).results.filter((e) => stopped.has(e.user))
    : []
  const errorsOf = Map.groupBy(errors, (e) => e.user)
  const steps = names.map((name, i) => {
    const hits = reached[i]
    const next = new Set(reached[i + 1]?.map((h) => h.user) ?? [])
    const dropped = i < names.length - 1 ? hits.filter((h) => !next.has(h.user)) : []
    const issueUsers = new Map<number, number>()
    let erred = 0
    for (const h of dropped) {
      const hit = (errorsOf.get(h.user) ?? []).filter((e) => e.at >= h.at && e.at <= h.at + FUNNEL_WINDOW)
      if (!hit.length) continue
      erred++
      for (const issue of new Set(hit.map((e) => e.issue))) issueUsers.set(issue, (issueUsers.get(issue) ?? 0) + 1)
    }
    const prev = reached[i - 1]
    const times = prev
      ? (() => {
          const at = new Map(prev.map((h) => [h.user, h.at]))
          return hits.map((h) => h.at - (at.get(h.user) ?? h.at)).sort((a, b) => a - b)
        })()
      : []
    return {
      name,
      users: hits.length,
      ofFirst: reached[0].length ? hits.length / reached[0].length : 0,
      ofPrevious: prev ? (prev.length ? hits.length / prev.length : 0) : 1,
      medianTime: times.length ? times[Math.floor(times.length / 2)] : null,
      dropped: dropped.length,
      droppedWithError: erred,
      issues: [...issueUsers].sort((a, b) => b[1] - a[1]).slice(0, 3),
    }
  })
  const ids = [...new Set(steps.flatMap((s) => s.issues.map(([id]) => id)))]
  const titles = ids.length
    ? new Map(
        (
          await db
            .prepare(`SELECT id, title, level FROM issues WHERE id IN (${ids.map(() => '?').join(', ')})`)
            .bind(...ids)
            .all<{ id: number; title: string; level: string }>()
        ).results.map((r) => [r.id, r]),
      )
    : new Map<number, { id: number; title: string; level: string }>()
  return steps.map((s) => ({
    ...s,
    issues: s.issues.flatMap(([id, users]) => {
      const issue = titles.get(id)
      return issue ? [{ ...issue, users }] : []
    }),
  }))
}

/**
 * Weekly retention over the last `weeks` weeks: users by the week of their first action, and the share of each who
 * came back in each week after; then the same for everyone, split by whether they hit an error in their first week
 */
export async function retention(db: D1Database, projectId: number, weeks: number, now: number) {
  const since = now - weeks * WEEK
  const [firsts, active, errors] = await db.batch<Record<string, number | string>>([
    db
      .prepare(
        'SELECT user_hash AS user, MIN(timestamp) AS first FROM actions WHERE project_id = ? AND user_hash IS NOT NULL GROUP BY user_hash HAVING first >= ?',
      )
      .bind(projectId, since),
    db
      .prepare(
        'SELECT DISTINCT user_hash AS user, (timestamp - ?) / ? AS week FROM actions WHERE project_id = ? AND timestamp >= ? AND user_hash IS NOT NULL',
      )
      .bind(since, WEEK, projectId, since),
    db
      .prepare(
        'SELECT user_hash AS user, MIN(timestamp) AS at FROM events WHERE project_id = ? AND timestamp >= ? AND user_hash IS NOT NULL GROUP BY user_hash',
      )
      .bind(projectId, since),
  ])
  const firstOf = new Map(
    (firsts.results as { user: string; first: number }[]).map((r) => [r.user, Math.floor((r.first - since) / WEEK)]),
  )
  const firstAt = new Map((firsts.results as { user: string; first: number }[]).map((r) => [r.user, r.first]))
  const weeksOf = new Map<string, Set<number>>()
  for (const r of active.results as { user: string; week: number }[]) {
    const w = Math.floor(r.week)
    weeksOf.set(r.user, (weeksOf.get(r.user) ?? new Set()).add(w))
  }
  const erred = new Set(
    (errors.results as { user: string; at: number }[])
      .filter((e) => {
        const first = firstAt.get(e.user)
        return first !== undefined && e.at >= first && e.at < first + WEEK
      })
      .map((e) => e.user),
  )
  const cohorts = Array.from({ length: weeks }, (_, w) => {
    const users = [...firstOf].filter(([, f]) => f === w).map(([u]) => u)
    const open = weeks - w // weeks this cohort has had, its first included
    return {
      start: since + w * WEEK,
      users: users.length,
      // Share active k weeks after their first, for each k this cohort has reached
      weeks: Array.from({ length: open }, (_, k) =>
        users.length ? users.filter((u) => weeksOf.get(u)?.has(w + k)).length / users.length : 0,
      ),
    }
  })
  // Week k after the first, for those with and without an error in their first week, over cohorts that reached it
  const curve = (group: (u: string) => boolean) =>
    Array.from({ length: weeks }, (_, k) => {
      const eligible = [...firstOf].filter(([u, f]) => group(u) && f + k < weeks)
      if (!eligible.length || k === 0) return eligible.length ? 1 : null
      return eligible.filter(([u, f]) => weeksOf.get(u)?.has(f + k)).length / eligible.length
    })
  return {
    cohorts,
    withError: curve((u) => erred.has(u)),
    withoutError: curve((u) => !erred.has(u)),
    erredUsers: erred.size,
    users: firstOf.size,
  }
}
