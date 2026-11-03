// Product analytics for the dashboard, over `actions` (src/ingest/actions.ts): an overview of active users, new
// users, sessions and breakdowns; insights, a chart of chosen actions; one action's breakdowns; funnels; retention;
// flows; and users with their timeline. Actions and events hash their user alike, so each says which users also hit an
// error (an event of level error or fatal). Every read takes a `Filter`: release, platform, OS, country and one
// property, all bound. Events are windowed by `received`, which `events_project` indexes, then held to their own time.
import { userMatch } from '../search/user'
import { inBatches, PRUNE_BUDGET } from './projects'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const WEEK = 7 * DAY
/** Actions closer than this to each other are one visit, for flows */
const VISIT_GAP = 30 * 60_000
/** What counts as an error a user hit */
const ERROR_LEVELS = "level IN ('error', 'fatal')"
/** Rows a funnel or a flow reads at most; past it the answer says it's partial */
const MAX_ROWS = 200_000

export const FILTER_COLUMNS = ['release', 'platform', 'os', 'country'] as const
export type FilterColumn = (typeof FILTER_COLUMNS)[number]
export type Filter = Partial<Record<FilterColumn, string>> & { prop?: { key: string; value: string } }
/** What a breakdown can be by: a column, or `prop:<key>` for a property */
export const BREAKDOWN_COLUMNS = ['release', 'platform', 'os', 'device', 'browser', 'country', 'environment'] as const

/** A property's value as text, `true` and `false` for booleans; binds the key twice */
const prop = (col: string) =>
  `(CASE json_type(${col}, '$.' || json_quote(?)) WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE CAST(json_extract(${col}, '$.' || json_quote(?)) AS TEXT) END)`

/** A filter as SQL over `actions` (alias `a`): each condition and its values, all bound */
export function where(f: Filter = {}, a = 'a') {
  const sql: string[] = []
  const params: unknown[] = []
  for (const k of FILTER_COLUMNS) {
    const v = f[k]
    if (v === undefined) continue
    if (v === '') sql.push(`${a}.${k} IS NULL`)
    else {
      sql.push(`${a}.${k} = ?`)
      params.push(v)
    }
  }
  if (f.prop) {
    sql.push(`${prop(`${a}.properties`)} = ?`)
    params.push(f.prop.key, f.prop.key, f.prop.value)
  }
  return { sql: sql.map((s) => ` AND ${s}`).join(''), params }
}

/** A breakdown as a SQL expression and its params: a column (none as ''), a property, or one group */
function groupOf(by: string | undefined, a = 'a') {
  if (!by) return { sql: "''", params: [] as unknown[] }
  if ((BREAKDOWN_COLUMNS as readonly string[]).includes(by)) return { sql: `COALESCE(${a}.${by}, '')`, params: [] }
  const key = by.replace(/^prop:/, '')
  return { sql: `COALESCE(${prop(`${a}.properties`)}, '')`, params: [key, key] }
}

/** A chart's step for a period: an hour in a day, 6 hours in a week, a day beyond */
const stepOf = (days: number) => (days <= 1 ? HOUR : days <= 7 ? 6 * HOUR : DAY)
function stepsOf(since: number, now: number, step: number) {
  const first = since - (since % step)
  return Array.from({ length: Math.floor((now - first) / step) + 1 }, (_, i) => first + i * step)
}
const change = (now: number, before: number) => (before > 0 ? now / before - 1 : null)
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ')
// A step's start: the step is a whole constant in the SQL, as D1 binds numbers as REAL
const bucket = (step: number, col = 'a.timestamp') => `${col} - ${col} % ${Math.round(step)}`

/**
 * What the filter bar offers for the projects shown, from their last 30 days: each column's values by count, and the
 * properties' keys with their most frequent values (from the newest 5000 actions)
 */
export async function filterOptions(db: D1Database, projectIds: number[], now: number) {
  const columns = Object.fromEntries(FILTER_COLUMNS.map((c) => [c, [] as string[]])) as Record<FilterColumn, string[]>
  if (!projectIds.length) return { columns, properties: [] as { key: string; values: string[] }[] }
  const since = now - 30 * DAY
  const ids = marks(projectIds.length)
  const reads = await db.batch<{ value: string; key?: string; n: number }>([
    ...FILTER_COLUMNS.map((c) =>
      db
        .prepare(
          `SELECT ${c} AS value, COUNT(*) AS n FROM actions WHERE project_id IN (${ids}) AND timestamp >= ? AND ${c} IS NOT NULL GROUP BY value ORDER BY n DESC LIMIT 30`,
        )
        .bind(...projectIds, since),
    ),
    db
      .prepare(
        `SELECT p.key AS key, CASE p.type WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE CAST(p.value AS TEXT) END AS value, COUNT(*) AS n
           FROM (SELECT properties FROM actions WHERE project_id IN (${ids}) AND timestamp >= ? ORDER BY timestamp DESC LIMIT 5000) s,
           json_each(s.properties) p WHERE p.type NOT IN ('object', 'array', 'null') GROUP BY p.key, value ORDER BY n DESC`,
      )
      .bind(...projectIds, since),
  ])
  FILTER_COLUMNS.forEach((c, i) => (columns[c] = reads[i].results.map((r) => r.value)))
  const byKey = new Map<string, { n: number; values: string[] }>()
  for (const r of reads.at(-1)!.results) {
    const k = byKey.get(r.key!) ?? { n: 0, values: [] }
    k.n += r.n
    if (k.values.length < 20) k.values.push(r.value)
    byKey.set(r.key!, k)
  }
  const properties = [...byKey]
    .sort((x, y) => y[1].n - x[1].n)
    .slice(0, 30)
    .map(([key, v]) => ({ key, values: v.values }))
  return { columns, properties }
}

/**
 * A project's overview over a period: active, new and erring users and actions, each against the period before;
 * daily, weekly and monthly active users now and per day, and how many of the month's users come on a day; new users
 * and sessions per day; users by platform, OS, country, device and release; and the 50 most frequent actions
 */
export async function overview(db: D1Database, projectId: number, days: number, now: number, f: Filter = {}) {
  const span = days * DAY
  const since = now - span
  const w = where(f)
  const step = stepOf(days)
  const steps = stepsOf(since, now, step)
  const dayStarts = stepsOf(since, now, DAY)
  const breakdowns = ['platform', 'os', 'country', 'device', 'release'] as const
  const top = `SELECT a.name FROM actions a WHERE a.project_id = ? AND a.timestamp >= ?${w.sql} GROUP BY a.name ORDER BY COUNT(*) DESC LIMIT 50`
  const reads = await db.batch<Record<string, number | string>>([
    // 0, 1: the period and the one before; per user, only actions that name one
    db
      .prepare(
        `SELECT COUNT(*) AS actions, COUNT(a.user_hash) AS named, COUNT(DISTINCT a.user_hash) AS users FROM actions a WHERE a.project_id = ? AND a.timestamp >= ?${w.sql}`,
      )
      .bind(projectId, since, ...w.params),
    db
      .prepare(
        `SELECT COUNT(*) AS actions, COUNT(DISTINCT a.user_hash) AS users FROM actions a WHERE a.project_id = ? AND a.timestamp >= ? AND a.timestamp < ?${w.sql}`,
      )
      .bind(projectId, since - span, since, ...w.params),
    // 2: each user's days, from 30 days before the period, for the rolling weekly and monthly counts
    db
      .prepare(
        `SELECT DISTINCT ${bucket(DAY)} AS day, a.user_hash AS user FROM actions a
          WHERE a.project_id = ? AND a.timestamp >= ? AND a.user_hash IS NOT NULL${w.sql}`,
      )
      .bind(projectId, dayStarts[0] - 30 * DAY, ...w.params),
    // 3: each user's first action ever, for new users in this period and the one before
    db
      .prepare(
        `SELECT MIN(a.timestamp) AS first FROM actions a WHERE a.project_id = ? AND a.user_hash IS NOT NULL${w.sql}
          GROUP BY a.user_hash HAVING first >= ?`,
      )
      .bind(projectId, ...w.params, since - span),
    // 4: users who hit an error in the period
    db
      .prepare(
        `SELECT COUNT(DISTINCT a.user_hash) AS users FROM actions a WHERE a.project_id = ? AND a.timestamp >= ?${w.sql}
           AND a.user_hash IN (SELECT user_hash FROM events WHERE project_id = ? AND received >= ? AND user_hash IS NOT NULL AND ${ERROR_LEVELS})`,
      )
      .bind(projectId, since, ...w.params, projectId, since),
    // 5: sessions per UTC day, from the SDK's sessions (release health); only a release filter applies
    db
      .prepare(
        `SELECT day, SUM(started) AS n FROM sessions_daily WHERE project_id = ? AND day >= ?${f.release ? ' AND release = ?' : ''} GROUP BY day`,
      )
      .bind(projectId, dayKey(dayStarts[0]), ...(f.release ? [f.release] : [])),
    // 6, 7: actions per step, and per step for the 50 most frequent
    db
      .prepare(
        `SELECT ${bucket(step)} AS at, COUNT(*) AS n FROM actions a WHERE a.project_id = ? AND a.timestamp >= ?${w.sql} GROUP BY at`,
      )
      .bind(projectId, steps[0], ...w.params),
    db
      .prepare(
        `SELECT a.name AS name, ${bucket(step)} AS at, COUNT(*) AS n FROM actions a WHERE a.project_id = ? AND a.timestamp >= ?${w.sql}
          AND a.name IN (${top}) GROUP BY name, at`,
      )
      .bind(projectId, steps[0], ...w.params, projectId, since, ...w.params),
    // 8, 9: the 50 most frequent actions in the period, and the period before
    db
      .prepare(
        `SELECT a.name AS name, COUNT(*) AS count, COUNT(DISTINCT a.user_hash) AS users FROM actions a WHERE a.project_id = ? AND a.timestamp >= ?${w.sql} GROUP BY name ORDER BY count DESC LIMIT 50`,
      )
      .bind(projectId, since, ...w.params),
    db
      .prepare(
        `SELECT a.name AS name, COUNT(*) AS count FROM actions a WHERE a.project_id = ? AND a.timestamp >= ? AND a.timestamp < ?${w.sql}
          AND a.name IN (${top}) GROUP BY name`,
      )
      .bind(projectId, since - span, since, ...w.params, projectId, since, ...w.params),
    // 10…: users by each breakdown
    ...breakdowns.map((c) =>
      db
        .prepare(
          `SELECT COALESCE(a.${c}, '') AS value, COUNT(DISTINCT a.user_hash) AS users FROM actions a WHERE a.project_id = ? AND a.timestamp >= ? AND a.user_hash IS NOT NULL${w.sql} GROUP BY value ORDER BY users DESC LIMIT 8`,
        )
        .bind(projectId, since, ...w.params),
    ),
  ])
  const t = reads[0].results[0] as { actions: number; named: number; users: number }
  const b = reads[1].results[0] as { actions: number; users: number }
  // Rolling active users per day: that day, its 7 days and its 30 days
  const usersOn = new Map<number, Set<string>>()
  for (const r of reads[2].results as { day: number; user: string }[]) {
    const s = usersOn.get(r.day) ?? new Set<string>()
    s.add(r.user)
    usersOn.set(r.day, s)
  }
  const activeOver = (end: number, n: number) => {
    const seen = new Set<string>()
    for (let d = end - (n - 1) * DAY; d <= end; d += DAY) for (const u of usersOn.get(d) ?? []) seen.add(u)
    return seen.size
  }
  const today = now - (now % DAY)
  const mauNow = activeOver(today, 30)
  const dauAvg30 =
    Array.from({ length: 30 }, (_, i) => usersOn.get(today - i * DAY)?.size ?? 0).reduce((x, y) => x + y, 0) / 30
  const firsts = (reads[3].results as { first: number }[]).map((r) => r.first)
  const newNow = firsts.filter((x) => x >= since).length
  const newByDay = new Map<number, number>()
  for (const x of firsts) {
    const d = x - (x % DAY)
    if (d >= dayStarts[0]) newByDay.set(d, (newByDay.get(d) ?? 0) + 1)
  }
  const sessions = new Map((reads[5].results as { day: string; n: number }[]).map((r) => [r.day, r.n]))
  const perStep = new Map((reads[6].results as { at: number; n: number }[]).map((r) => [r.at, r.n]))
  const trends = new Map<string, Map<number, number>>()
  for (const r of reads[7].results as { name: string; at: number; n: number }[]) {
    const m = trends.get(r.name) ?? new Map<number, number>()
    m.set(r.at, r.n)
    trends.set(r.name, m)
  }
  const previous = new Map((reads[9].results as { name: string; count: number }[]).map((r) => [r.name, r.count]))
  const erred = (reads[4].results[0] as { users: number }).users
  return {
    users: t.users,
    usersChange: change(t.users, b.users),
    actions: t.actions,
    // Actions without a user would only inflate it
    anonymous: t.actions - t.named,
    actionsChange: change(t.actions, b.actions),
    perUser: t.users ? t.named / t.users : null,
    newUsers: newNow,
    newUsersChange: change(newNow, firsts.length - newNow),
    withErrors: t.users ? erred / t.users : null,
    dauNow: usersOn.get(today)?.size ?? 0,
    wauNow: activeOver(today, 7),
    mauNow,
    stickiness: mauNow ? dauAvg30 / mauNow : null,
    days: dayStarts,
    dau: dayStarts.map((d) => usersOn.get(d)?.size ?? 0),
    wau: dayStarts.map((d) => activeOver(d, 7)),
    mau: dayStarts.map((d) => activeOver(d, 30)),
    newPerDay: dayStarts.map((d) => newByDay.get(d) ?? 0),
    sessionsPerDay: dayStarts.map((d) => sessions.get(dayKey(d)) ?? null),
    steps,
    actionsPerStep: steps.map((at) => perStep.get(at) ?? 0),
    breakdowns: Object.fromEntries(
      breakdowns.map((c, i) => [c, reads[10 + i].results as { value: string; users: number }[]]),
    ) as Record<(typeof breakdowns)[number], { value: string; users: number }[]>,
    list: (reads[8].results as { name: string; count: number; users: number }[]).map((r) => ({
      ...r,
      change: change(r.count, previous.get(r.name) ?? 0),
      trend: steps.map((at) => trends.get(r.name)?.get(at) ?? 0),
    })),
  }
}

/** Whether a project has had any action in the last 90 days, and their names, most frequent first */
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

export const MEASURES = ['total', 'users', 'per_user'] as const
export type Measure = (typeof MEASURES)[number]
/** At most this many lines on an insight's chart */
const MAX_SERIES = 8

/**
 * Insights: each action chosen, measured per step as a total, unique users or per user, split by a breakdown (its
 * biggest groups across the actions, `MAX_SERIES` lines at most), each line's total against the period before
 */
export async function insights(
  db: D1Database,
  projectId: number,
  q: { names: string[]; measure: Measure; by?: string; days: number },
  now: number,
  f: Filter = {},
) {
  const span = q.days * DAY
  const since = now - span
  const step = stepOf(q.days)
  const steps = stepsOf(since, now, step)
  const w = where(f)
  const g = groupOf(q.by)
  const names = marks(q.names.length)
  type Row = { name: string; g: string; at: number; now: number; n: number; u: number }
  const [perStep, totals] = await db.batch<Row>([
    db
      .prepare(
        `SELECT a.name AS name, ${g.sql} AS g, ${bucket(step)} AS at, COUNT(*) AS n, COUNT(DISTINCT a.user_hash) AS u
          FROM actions a WHERE a.project_id = ? AND a.timestamp >= ? AND a.name IN (${names})${w.sql} GROUP BY name, g, at`,
      )
      .bind(...g.params, projectId, steps[0], ...q.names, ...w.params),
    // The whole period and the one before, per line: distinct users don't add up across steps
    db
      .prepare(
        `SELECT a.name AS name, ${g.sql} AS g, a.timestamp >= ? AS now, COUNT(*) AS n, COUNT(DISTINCT a.user_hash) AS u
          FROM actions a WHERE a.project_id = ? AND a.timestamp >= ? AND a.name IN (${names})${w.sql} GROUP BY name, g, now`,
      )
      .bind(...g.params, since, projectId, since - span, ...q.names, ...w.params),
  ])
  const value = (n: number, u: number) => (q.measure === 'total' ? n : q.measure === 'users' ? u : u ? n / u : 0)
  const key = (name: string, group: string) => `${name}\n${group}`
  const whole = new Map<string, { now: number; before: number }>()
  for (const r of totals.results) {
    const k = key(r.name, r.g)
    const t = whole.get(k) ?? { now: 0, before: 0 }
    if (r.now) t.now = value(r.n, r.u)
    else t.before = value(r.n, r.u)
    whole.set(k, t)
  }
  const lines = [...whole]
    .filter(([, t]) => t.now > 0)
    .sort((x, y) => y[1].now - x[1].now)
    .slice(0, MAX_SERIES)
    .map(([k]) => k)
  const cells = new Map<string, Map<number, number>>()
  for (const r of perStep.results) {
    const k = key(r.name, r.g)
    if (!lines.includes(k)) continue
    const m = cells.get(k) ?? new Map<number, number>()
    m.set(r.at, value(r.n, r.u))
    cells.set(k, m)
  }
  return {
    steps,
    series: lines
      .map((k) => {
        const [name, group] = k.split('\n')
        const t = whole.get(k)!
        return {
          key: k,
          name,
          group: q.by ? group : null,
          values: steps.map((at) => cells.get(k)?.get(at) ?? 0),
          total: t.now,
          previous: t.before,
          change: change(t.now, t.before),
        }
      })
      // In the order the actions were chosen, then biggest first
      .sort((x, y) => q.names.indexOf(x.name) - q.names.indexOf(y.name) || y.total - x.total),
  }
}

/**
 * One action over a period: count and users per step, its properties (the keys seen) and the values of `by` (the
 * first key when none), by release, platform and country, and the issues whose events shared a trace with its newest
 * 2000 traces
 */
export async function action(
  db: D1Database,
  projectId: number,
  name: string,
  days: number,
  now: number,
  by?: string,
  f: Filter = {},
) {
  const since = now - days * DAY
  const step = stepOf(days)
  const steps = stepsOf(since, now, step)
  const w = where(f)
  const breakdown = (col: string) =>
    db
      .prepare(
        `SELECT COALESCE(a.${col}, '') AS value, COUNT(*) AS count FROM actions a WHERE a.project_id = ? AND a.name = ? AND a.timestamp >= ?${w.sql} GROUP BY value ORDER BY count DESC LIMIT 8`,
      )
      .bind(projectId, name, since, ...w.params)
  const [perStep, total, keys, releases, platforms, countries, issues] = await db.batch<
    Record<string, number | string>
  >([
    db
      .prepare(
        `SELECT ${bucket(step)} AS at, COUNT(*) AS count, COUNT(DISTINCT a.user_hash) AS users FROM actions a WHERE a.project_id = ? AND a.name = ? AND a.timestamp >= ?${w.sql} GROUP BY at`,
      )
      .bind(projectId, name, steps[0], ...w.params),
    db
      .prepare(
        `SELECT COUNT(*) AS count, COUNT(DISTINCT a.user_hash) AS users FROM actions a WHERE a.project_id = ? AND a.name = ? AND a.timestamp >= ?${w.sql}`,
      )
      .bind(projectId, name, since, ...w.params),
    db
      .prepare(
        `SELECT p.key AS key, COUNT(*) AS count FROM actions a, json_each(a.properties) AS p WHERE a.project_id = ? AND a.name = ? AND a.timestamp >= ?${w.sql} GROUP BY p.key ORDER BY count DESC LIMIT 20`,
      )
      .bind(projectId, name, since, ...w.params),
    breakdown('release'),
    breakdown('platform'),
    breakdown('country'),
    db
      .prepare(
        `WITH t AS (SELECT DISTINCT a.trace_id AS trace FROM actions a WHERE a.project_id = ? AND a.name = ? AND a.timestamp >= ?
             AND a.trace_id IS NOT NULL${w.sql} ORDER BY a.timestamp DESC LIMIT 2000)
         SELECT i.id AS id, i.title AS title, i.level AS level, COUNT(DISTINCT e.trace_id) AS traces
           FROM t JOIN events e ON e.trace_id = t.trace JOIN issues i ON i.id = e.issue_id
          WHERE e.project_id = ? GROUP BY i.id ORDER BY traces DESC LIMIT 5`,
      )
      .bind(projectId, name, since, ...w.params, projectId),
  ])
  const keyList = (keys.results as { key: string }[]).map((k) => k.key)
  const key = by && keyList.includes(by) ? by : keyList[0]
  const g = groupOf(key ? `prop:${key}` : undefined)
  const values = key
    ? (
        await db
          .prepare(
            `SELECT ${g.sql} AS value, COUNT(*) AS count FROM actions a WHERE a.project_id = ? AND a.name = ? AND a.timestamp >= ?${w.sql} GROUP BY value ORDER BY count DESC LIMIT 10`,
          )
          .bind(...g.params, projectId, name, since, ...w.params)
          .all<{ value: string; count: number }>()
      ).results.map((v) => ({ value: v.value || '(none)', count: v.count }))
    : []
  const rows = new Map((perStep.results as { at: number; count: number; users: number }[]).map((r) => [r.at, r]))
  const list = (r: D1Result<Record<string, number | string>>) =>
    (r.results as { value: string; count: number }[]).map((v) => ({ value: v.value || '(none)', count: v.count }))
  const t = total.results[0] as { count: number; users: number }
  return {
    steps,
    counts: steps.map((at) => rows.get(at)?.count ?? 0),
    users: steps.map((at) => rows.get(at)?.users ?? 0),
    total: t.count,
    totalUsers: t.users,
    keys: keyList,
    by: key,
    values,
    releases: list(releases),
    platforms: list(platforms),
    countries: list(countries),
    issues: issues.results as { id: number; title: string; level: string; traces: number }[],
  }
}

/** How long after a step the next one counts for a funnel */
export const FUNNEL_WINDOW = DAY

type Chain = { at: number[]; g: string }

/**
 * Each user's furthest way through a funnel's steps, in order, each within the window of the step before. A step
 * done again starts its chain again from there, so someone who opened the app on day 1 and again on day 9, then
 * signed up, converted from day 9; a step named twice needs two of it. Rows are one user's, oldest first.
 */
export function walk(names: string[], rows: { name: string; at: number; g: string }[], window = FUNNEL_WINDOW) {
  // chains[k]: the newest chain that has reached step k
  const chains: (Chain | undefined)[] = names.map(() => undefined)
  for (const r of rows)
    for (let k = names.length - 1; k >= 0; k--) {
      if (r.name !== names[k]) continue
      if (k === 0) chains[0] = { at: [r.at], g: r.g }
      else {
        const before = chains[k - 1]
        if (before && r.at >= before.at[k - 1] && r.at - before.at[k - 1] <= window)
          chains[k] = { at: [...before.at, r.at], g: before.g }
      }
    }
  for (let k = names.length - 1; k >= 0; k--) if (chains[k]) return chains[k]
  return undefined
}

/**
 * A funnel: of the users who did the first step in the period, how many did each next one (`walk`). Of those who
 * stopped at a step, how many hit an error before the next would have been due, and the issues they hit most. With
 * `by`, each group's conversion, the group being the user's at the first step.
 */
export async function funnel(
  db: D1Database,
  projectId: number,
  names: string[],
  days: number,
  now: number,
  f: Filter = {},
  by?: string,
) {
  const since = now - days * DAY
  const unique = [...new Set(names)]
  const w = where(f)
  const g = groupOf(by)
  const rows = (
    await db
      .prepare(
        `SELECT a.user_hash AS user, a.name AS name, a.timestamp AS at, ${g.sql} AS g FROM actions a
          WHERE a.project_id = ? AND a.timestamp >= ? AND a.name IN (${marks(unique.length)}) AND a.user_hash IS NOT NULL${w.sql}
          ORDER BY a.user_hash, a.timestamp LIMIT ${MAX_ROWS}`,
      )
      .bind(...g.params, projectId, since, ...unique, ...w.params)
      .all<{ user: string; name: string; at: number; g: string }>()
  ).results
  const partial = rows.length === MAX_ROWS
  const chains = [...Map.groupBy(rows, (r) => r.user)].flatMap(([user, own]) => {
    const chain = walk(names, own)
    return chain ? [{ user, ...chain }] : []
  })
  const reachedAt = (k: number) => chains.filter((c) => c.at.length > k)
  // Errors of the users who stopped somewhere, read for those users only
  const stopped = chains.filter((c) => c.at.length < names.length)
  const errors = stopped.length
    ? (
        await db
          .prepare(
            `SELECT user_hash AS user, issue_id AS issue, timestamp AS at FROM events
              WHERE project_id = ? AND received >= ? AND ${ERROR_LEVELS} AND user_hash IN (SELECT value FROM json_each(?))`,
          )
          .bind(projectId, since, JSON.stringify(stopped.map((c) => c.user)))
          .all<{ user: string; issue: number; at: number }>()
      ).results
    : []
  const errorsOf = Map.groupBy(errors, (e) => e.user)
  const first = reachedAt(0).length
  const steps = names.map((name, i) => {
    const hits = reachedAt(i)
    const dropped = i < names.length - 1 ? hits.filter((c) => c.at.length === i + 1) : []
    const issueUsers = new Map<number, number>()
    let erred = 0
    for (const c of dropped) {
      const at = c.at[i]
      const hit = (errorsOf.get(c.user) ?? []).filter((e) => e.at >= at && e.at <= at + FUNNEL_WINDOW)
      if (!hit.length) continue
      erred++
      for (const issue of new Set(hit.map((e) => e.issue))) issueUsers.set(issue, (issueUsers.get(issue) ?? 0) + 1)
    }
    const times = i > 0 ? hits.map((c) => c.at[i] - c.at[i - 1]).sort((x, y) => x - y) : []
    const prev = i > 0 ? reachedAt(i - 1).length : 0
    return {
      name,
      users: hits.length,
      ofFirst: first ? hits.length / first : 0,
      ofPrevious: i > 0 ? (prev ? hits.length / prev : 0) : 1,
      medianTime: times.length ? times[Math.floor(times.length / 2)] : null,
      dropped: dropped.length,
      droppedWithError: erred,
      issues: [...issueUsers].sort((x, y) => y[1] - x[1]).slice(0, 3),
    }
  })
  const ids = [...new Set(steps.flatMap((s) => s.issues.map(([id]) => id)))]
  const titles = await issueTitles(db, ids)
  const groups = by
    ? [...Map.groupBy(chains, (c) => c.g)]
        .map(([value, list]) => {
          const done = list.filter((c) => c.at.length === names.length).length
          return { value: value || '(none)', started: list.length, finished: done, conversion: done / list.length }
        })
        .sort((x, y) => y.started - x.started)
        .slice(0, 8)
    : []
  return {
    partial,
    steps: steps.map((s) => ({
      ...s,
      issues: s.issues.flatMap(([id, users]) => {
        const issue = titles.get(id)
        return issue ? [{ ...issue, users }] : []
      }),
    })),
    groups,
  }
}

async function issueTitles(db: D1Database, ids: number[]) {
  if (!ids.length) return new Map<number, { id: number; title: string; level: string }>()
  return new Map(
    (
      await db
        .prepare(`SELECT id, title, level FROM issues WHERE id IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(ids))
        .all<{ id: number; title: string; level: string }>()
    ).results.map((r) => [r.id, r]),
  )
}

/** A project's saved funnels, newest first */
export async function savedFunnels(db: D1Database, projectId: number) {
  return (
    await db
      .prepare('SELECT id, name, steps, created_by FROM funnels WHERE project_id = ? ORDER BY created_at DESC LIMIT 50')
      .bind(projectId)
      .all<{ id: number; name: string; steps: string; created_by: string }>()
  ).results.map((r) => ({ ...r, steps: JSON.parse(r.steps) as string[] }))
}

export async function saveFunnel(
  db: D1Database,
  projectId: number,
  name: string,
  steps: string[],
  by: string,
  now: number,
) {
  return db
    .prepare(
      'INSERT INTO funnels (project_id, name, steps, created_by, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
    )
    .bind(projectId, name, JSON.stringify(steps), by, now)
    .first<{ id: number }>()
}

export async function deleteFunnel(db: D1Database, projectId: number, id: number) {
  await db.prepare('DELETE FROM funnels WHERE id = ? AND project_id = ?').bind(id, projectId).run()
}

/**
 * Weekly retention over the last `weeks` weeks: users by the week of their first action (or first `start` action),
 * and the share of each who came back (did any action, or `back`) in each week after; then the same for everyone,
 * split by whether they hit an error in their first week
 */
export async function retention(
  db: D1Database,
  projectId: number,
  weeks: number,
  now: number,
  f: Filter = {},
  q: { start?: string; back?: string } = {},
) {
  const since = now - weeks * WEEK
  const w = where(f)
  const named = (name?: string) => (name ? { sql: ' AND a.name = ?', params: [name] } : { sql: '', params: [] })
  const s = named(q.start)
  const r = named(q.back)
  const [firsts, active, errors] = await db.batch<Record<string, number | string>>([
    db
      .prepare(
        `SELECT a.user_hash AS user, MIN(a.timestamp) AS first FROM actions a WHERE a.project_id = ? AND a.user_hash IS NOT NULL${s.sql}${w.sql}
          GROUP BY a.user_hash HAVING first >= ?`,
      )
      .bind(projectId, ...s.params, ...w.params, since),
    db
      .prepare(
        `SELECT DISTINCT a.user_hash AS user, CAST((a.timestamp - ?) / ${WEEK} AS INTEGER) AS week FROM actions a
          WHERE a.project_id = ? AND a.timestamp >= ? AND a.user_hash IS NOT NULL${r.sql}${w.sql}`,
      )
      .bind(since, projectId, since, ...r.params, ...w.params),
    // Every error of a user in the span: one before their first action doesn't count, one in their first week does
    db
      .prepare(
        `SELECT user_hash AS user, timestamp AS at FROM events WHERE project_id = ? AND received >= ? AND user_hash IS NOT NULL AND ${ERROR_LEVELS}`,
      )
      .bind(projectId, since),
  ])
  const firstAt = new Map((firsts.results as { user: string; first: number }[]).map((x) => [x.user, x.first]))
  const firstOf = new Map([...firstAt].map(([u, first]) => [u, Math.floor((first - since) / WEEK)]))
  const weeksOf = new Map<string, Set<number>>()
  for (const x of active.results as { user: string; week: number }[])
    weeksOf.set(x.user, (weeksOf.get(x.user) ?? new Set()).add(x.week))
  const erred = new Set(
    (errors.results as { user: string; at: number }[])
      .filter((e) => {
        const first = firstAt.get(e.user)
        return first !== undefined && e.at >= first && e.at < first + WEEK
      })
      .map((e) => e.user),
  )
  const cohorts = Array.from({ length: weeks }, (_, wk) => {
    const users = [...firstOf].filter(([, x]) => x === wk).map(([u]) => u)
    return {
      start: since + wk * WEEK,
      users: users.length,
      // Week 0 is everyone; each week after, the share active then, for each week this cohort has reached
      weeks: Array.from({ length: weeks - wk }, (_, k) =>
        k === 0 ? 1 : users.length ? users.filter((u) => weeksOf.get(u)?.has(wk + k)).length / users.length : 0,
      ),
    }
  })
  // Week k after the first, for those with and without an error in their first week, over cohorts that reached it
  const curve = (group: (u: string) => boolean) =>
    Array.from({ length: weeks }, (_, k) => {
      const eligible = [...firstOf].filter(([u, x]) => group(u) && x + k < weeks)
      if (!eligible.length) return null
      if (k === 0) return 1
      return eligible.filter(([u, x]) => weeksOf.get(u)?.has(x + k)).length / eligible.length
    })
  return {
    cohorts,
    withError: curve((u) => erred.has(u)),
    withoutError: curve((u) => !erred.has(u)),
    erredUsers: erred.size,
    users: firstOf.size,
  }
}

/** A flow's step: an action, an error (`error:<issue id>`), or the end of the visit */
export const END = 'end'

/**
 * Flows: what users did after (or before) their first `anchor` in the period, step by step within the same visit
 * (actions under 30 minutes apart), with their errors among the steps: per step its most frequent next steps, and
 * the most frequent paths whole
 */
export async function flows(
  db: D1Database,
  projectId: number,
  anchor: string,
  direction: 'after' | 'before',
  days: number,
  now: number,
  f: Filter = {},
  depth = 4,
) {
  const since = now - days * DAY
  const w = where(f)
  const rows = (
    await db
      .prepare(
        `SELECT a.user_hash AS user, a.name AS name, a.timestamp AS at FROM actions a
          WHERE a.project_id = ? AND a.timestamp >= ? AND a.user_hash IN (
            SELECT b.user_hash FROM actions b WHERE b.project_id = ? AND b.name = ? AND b.timestamp >= ? AND b.user_hash IS NOT NULL${where(f, 'b').sql})
          ORDER BY a.user_hash, a.timestamp LIMIT ${MAX_ROWS}`,
      )
      .bind(projectId, since - DAY, projectId, anchor, since, ...w.params)
      .all<{ user: string; name: string; at: number }>()
  ).results
  const users = [...new Set(rows.map((r) => r.user))]
  const errors = users.length
    ? (
        await db
          .prepare(
            `SELECT user_hash AS user, issue_id AS issue, timestamp AS at FROM events
              WHERE project_id = ? AND received >= ? AND ${ERROR_LEVELS} AND user_hash IN (SELECT value FROM json_each(?))`,
          )
          .bind(projectId, since - DAY, JSON.stringify(users))
          .all<{ user: string; issue: number; at: number }>()
      ).results
    : []
  const errorsOf = Map.groupBy(errors, (e) => e.user)
  const columns = Array.from({ length: depth }, () => new Map<string, number>())
  const paths = new Map<string, number>()
  let count = 0
  for (const [user, own] of Map.groupBy(rows, (r) => r.user)) {
    const start = own.findIndex((r) => r.name === anchor && r.at >= since)
    if (start === -1) continue
    count++
    const at = own[start].at
    // Their actions and errors in time order, the anchor itself left out
    const timeline = [
      ...own.filter((_, i) => i !== start).map((r) => ({ at: r.at, label: r.name })),
      ...(errorsOf.get(user) ?? []).map((e) => ({ at: e.at, label: `error:${e.issue}` })),
    ].sort((x, y) => x.at - y.at)
    const side =
      direction === 'after' ? timeline.filter((x) => x.at >= at) : timeline.filter((x) => x.at <= at).reverse()
    const path: string[] = []
    let last = at
    for (const x of side) {
      if (Math.abs(x.at - last) > VISIT_GAP || path.length === depth) break
      path.push(x.label)
      last = x.at
    }
    if (path.length < depth) path.push(END)
    path.forEach((label, k) => columns[k].set(label, (columns[k].get(label) ?? 0) + 1))
    const whole = path.join('\n')
    paths.set(whole, (paths.get(whole) ?? 0) + 1)
  }
  const top = (m: Map<string, number>, n: number) =>
    [...m]
      .sort((x, y) => y[1] - x[1])
      .slice(0, n)
      .map(([label, n]) => ({ label, count: n }))
  const shownColumns = columns.map((c) => ({ total: [...c.values()].reduce((x, y) => x + y, 0), items: top(c, 6) }))
  const shownPaths = top(paths, 10).map((p) => ({ steps: p.label.split('\n'), count: p.count }))
  const ids = [
    ...new Set(
      [...shownColumns.flatMap((c) => c.items.map((i) => i.label)), ...shownPaths.flatMap((p) => p.steps)]
        .filter((l) => l.startsWith('error:'))
        .map((l) => Number(l.slice(6))),
    ),
  ]
  return {
    users: count,
    partial: rows.length === MAX_ROWS,
    columns: shownColumns,
    paths: shownPaths,
    issues: Object.fromEntries(await issueTitles(db, ids)),
  }
}

/**
 * Users in a period, the most recently seen first: each as their hash, first and last seen, actions, their latest
 * platform, OS, device, country and release, and their errors in the period
 */
export async function users(db: D1Database, projectId: number, days: number, now: number, f: Filter = {}) {
  const since = now - days * DAY
  const w = where(f)
  // The bare columns come from the row of MAX(timestamp), as SQLite does with one MIN or MAX
  const [latest, counts, totals] = await db.batch<Record<string, string | number | null>>([
    db
      .prepare(
        `SELECT a.user_hash AS user, MAX(a.timestamp) AS last, a.platform AS platform, a.os AS os, a.device AS device,
            a.country AS country, a.release AS release
          FROM actions a WHERE a.project_id = ? AND a.timestamp >= ? AND a.user_hash IS NOT NULL${w.sql}
          GROUP BY a.user_hash ORDER BY last DESC LIMIT 50`,
      )
      .bind(projectId, since, ...w.params),
    db
      .prepare(
        `SELECT a.user_hash AS user, COUNT(*) AS actions FROM actions a WHERE a.project_id = ? AND a.timestamp >= ? AND a.user_hash IS NOT NULL${w.sql}
          GROUP BY a.user_hash ORDER BY MAX(a.timestamp) DESC LIMIT 50`,
      )
      .bind(projectId, since, ...w.params),
    db
      .prepare(
        `SELECT COUNT(DISTINCT a.user_hash) AS users FROM actions a WHERE a.project_id = ? AND a.timestamp >= ?${w.sql}`,
      )
      .bind(projectId, since, ...w.params),
  ])
  const list = latest.results as {
    user: string
    last: number
    platform: string | null
    os: string | null
    device: string | null
    country: string | null
    release: string | null
  }[]
  const hashes = JSON.stringify(list.map((u) => u.user))
  const [firsts, errs] = list.length
    ? await db.batch<{ user: string; v: number }>([
        db
          .prepare(
            'SELECT user_hash AS user, MIN(timestamp) AS v FROM actions WHERE project_id = ? AND user_hash IN (SELECT value FROM json_each(?)) GROUP BY user_hash',
          )
          .bind(projectId, hashes),
        db
          .prepare(
            `SELECT user_hash AS user, COUNT(*) AS v FROM events WHERE project_id = ? AND received >= ? AND ${ERROR_LEVELS} AND user_hash IN (SELECT value FROM json_each(?)) GROUP BY user_hash`,
          )
          .bind(projectId, since, hashes),
      ])
    : [{ results: [] }, { results: [] }]
  const map = (r: { results: { user: string; v: number }[] }) => new Map(r.results.map((x) => [x.user, x.v]))
  const firstOf = map(firsts)
  const errorsOf = map(errs)
  const actionsOf = new Map((counts.results as { user: string; actions: number }[]).map((x) => [x.user, x.actions]))
  return {
    total: (totals.results[0] as { users: number }).users,
    list: list.map((u) => ({
      ...u,
      first: firstOf.get(u.user) ?? u.last,
      actions: actionsOf.get(u.user) ?? 0,
      errors: errorsOf.get(u.user) ?? 0,
    })),
  }
}

/**
 * One user's timeline, by their hash: their newest 300 actions and 100 errors in time order, newest first, and what's
 * known of them: first and last seen, where, and each property's latest value
 */
export async function userTimeline(db: D1Database, projectId: number, user: string) {
  const [actions, events, summary] = await db.batch<Record<string, string | number | null>>([
    db
      .prepare(
        `SELECT timestamp AS at, name, release, platform, os, device, country, trace_id, properties FROM actions
          WHERE project_id = ? AND user_hash = ? ORDER BY timestamp DESC LIMIT 300`,
      )
      .bind(projectId, user),
    db
      .prepare(
        `SELECT e.id AS id, e.timestamp AS at, e.issue_id AS issue, i.title AS title, e.level AS level, e.release AS release, e.trace_id AS trace_id
          FROM events e JOIN issues i ON i.id = e.issue_id WHERE e.project_id = ? AND e.user_hash = ? ORDER BY e.received DESC LIMIT 100`,
      )
      .bind(projectId, user),
    db
      .prepare(
        'SELECT MIN(timestamp) AS first, MAX(timestamp) AS last, COUNT(*) AS actions FROM actions WHERE project_id = ? AND user_hash = ?',
      )
      .bind(projectId, user),
  ])
  type A = {
    at: number
    name: string
    release: string | null
    platform: string | null
    os: string | null
    device: string | null
    country: string | null
    trace_id: string | null
    properties: string
  }
  type E = {
    id: string
    at: number
    issue: number
    title: string
    level: string
    release: string | null
    trace_id: string | null
  }
  const acts = actions.results as A[]
  const errs = events.results as E[]
  // Each property's newest value, from the newest action that has it
  const properties: Record<string, string | number | boolean> = {}
  for (const a of acts)
    for (const [k, v] of Object.entries(JSON.parse(a.properties) as Record<string, string | number | boolean>))
      if (!(k in properties)) properties[k] = v
  const s = summary.results[0] as { first: number | null; last: number | null; actions: number }
  const newest = acts[0]
  return {
    first: s.first,
    last: s.last,
    actions: s.actions,
    errors: errs.filter((e) => e.level === 'error' || e.level === 'fatal').length,
    platform: newest?.platform ?? null,
    os: newest?.os ?? null,
    device: newest?.device ?? null,
    country: newest?.country ?? null,
    release: newest?.release ?? null,
    properties,
    timeline: [
      ...acts.map((a) => ({
        kind: 'action' as const,
        at: a.at,
        name: a.name,
        release: a.release,
        trace: a.trace_id,
        properties: JSON.parse(a.properties) as Record<string, string | number | boolean>,
      })),
      ...errs.map((e) => ({
        kind: 'error' as const,
        at: e.at,
        issue: e.issue,
        event: e.id,
        title: e.title,
        level: e.level,
        release: e.release,
        trace: e.trace_id,
      })),
    ].sort((x, y) => y.at - x.at),
  }
}

/**
 * Actions past their project's retention (`projects.action_retention_days`), 1000 a batch until done or the deadline
 * (the hourly cron's, in the same budget as logs)
 */
export async function pruneActions(db: D1Database, now: number, deadline = Date.now() + PRUNE_BUDGET) {
  const actions = await inBatches(
    deadline,
    async () =>
      (
        await db
          .prepare(
            `DELETE FROM actions WHERE id IN (SELECT a.id FROM actions a JOIN projects p ON p.id = a.project_id
             WHERE a.timestamp < ? - p.action_retention_days * 86400000 LIMIT 1000)`,
          )
          .bind(now)
          .run()
      ).meta.changes ?? 0,
  )
  // The users' field hashes go with their actions' retention, by when each was last seen
  const users = await inBatches(
    deadline,
    async () =>
      (
        await db
          .prepare(
            `DELETE FROM action_users WHERE (project_id, key) IN (SELECT u.project_id, u.key FROM action_users u
             JOIN projects p ON p.id = u.project_id WHERE u.seen < ? - p.action_retention_days * 86400000 LIMIT 1000)`,
          )
          .bind(now)
          .run()
      ).meta.changes ?? 0,
  )
  return { actions, users }
}

/**
 * The user hash a typed id, email or username names in a project's actions (`action_users`, by `userMatch`'s field
 * hashes), the most recently seen when several do; else the typed text hashed as ingest hashes an id, which also finds
 * actions stored before 0037
 */
export async function findUser(db: D1Database, projectId: number, typed: string) {
  const { legacy, keys } = userMatch('user', typed)
  const row = await db
    .prepare(
      `SELECT user_hash AS user FROM action_users WHERE project_id = ? AND key IN (${marks(keys.length)}) ORDER BY seen DESC LIMIT 1`,
    )
    .bind(projectId, ...keys)
    .first<{ user: string }>()
  return row?.user ?? legacy
}
