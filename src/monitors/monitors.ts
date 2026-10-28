// Monitors at work: check-ins as they arrive, and the minute's job (missed runs, runs that took too long, uptime
// checks). Each result moves the monitor's count of failures or successes in a row; crossing its threshold opens
// or closes an incident, and tells the routes (`monitor_down`, `monitor_up`).
import type { Notice } from '../notify/notice'
import { nextRun, type Schedule } from './schedule'

export type CronConfig = { schedule: Schedule; timezone?: string; checkinMargin?: number; maxRuntime?: number }
/** What an uptime check's answer must be: a status among some, a header containing a value, a JSON path equal to one */
export type Assertion =
  | { kind: 'status'; in: number[] }
  | { kind: 'header'; name: string; contains: string }
  | { kind: 'json'; path: string; equals: string }

export type UptimeConfig = {
  url: string
  method?: string
  headers?: [string, string][]
  body?: string // sent with POST, PUT and PATCH
  assertions?: Assertion[]
  expectedStatus?: number // or any 2xx; a status assertion takes its place
  mustContain?: string
  intervalMinutes: number
  timeoutMs?: number
}

export const UPTIME_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const
export const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

export type MonitorRow = {
  id: number
  project_id: number
  slug: string
  name: string
  kind: 'cron' | 'uptime'
  config: string
  failure_threshold: number
  recovery_threshold: number
  status: 'pending' | 'ok' | 'failing' | 'paused'
  failures: number
  successes: number
  next_due: number | null
  last_seen: number | null
  environment: string
  muted_at: number | null
}

type Env = { DB: D1Database; PUBLIC_URL?: string }
const MINUTE = 60_000
/** Uptime checks in flight at once, under the 6 connections a Worker keeps open */
const UPTIME_AT_ONCE = 5
/** The most of a response an uptime check reads, for text it must contain or a JSON path */
const MAX_BODY = 1024 * 1024
/** Cron monitors a project's check-ins can make; past them a new slug's check-in is dropped */
export const MAX_CRON_MONITORS = 200
/** A monitor failing this long is muted: no more alerts until it recovers, as Sentry's crons do */
export const MUTE_AFTER = 14 * 1440 * MINUTE

/** Where the monitor stands after one more result, and whether that opened or closed an incident */
export function afterResult(
  m: Pick<MonitorRow, 'status' | 'failures' | 'successes' | 'failure_threshold' | 'recovery_threshold'>,
  ok: boolean,
) {
  if (ok) {
    const successes = m.successes + 1
    const back = m.status === 'failing' && successes >= m.recovery_threshold
    return {
      status: m.status === 'failing' && !back ? 'failing' : 'ok',
      failures: 0,
      successes,
      change: back ? ('up' as const) : undefined,
    }
  }
  const failures = m.failures + 1
  const down = m.status !== 'failing' && failures >= m.failure_threshold
  return {
    status: down || m.status === 'failing' ? 'failing' : m.status,
    failures,
    successes: 0,
    change: down ? ('down' as const) : undefined,
  }
}

/** When a cron monitor's next check-in is late: the next run after this one, plus its margin (a minute by default) */
export function dueAfter(config: CronConfig, at: number) {
  return nextRun(config.schedule, at, config.timezone) + (config.checkinMargin ?? 1) * MINUTE
}

const REASONS: Record<string, string> = {
  error: 'failed',
  missed: 'missed its check-in',
  timeout: 'ran longer than allowed',
}

/** Writes a result's effect on the monitor; returns the notice to send, if an incident opened or closed */
async function apply(
  env: Env,
  monitor: MonitorRow,
  ok: boolean,
  reason: string,
  now: number,
  nextDue: number | null,
): Promise<Notice | undefined> {
  const next = afterResult(monitor, ok)
  const statements = [
    env.DB.prepare(
      'UPDATE monitors SET status = ?, failures = ?, successes = ?, next_due = ?, last_seen = ? WHERE id = ?',
    ).bind(next.status, next.failures, next.successes, nextDue, now, monitor.id),
  ]
  if (next.change === 'down')
    statements.push(
      env.DB.prepare('INSERT INTO incidents (monitor_id, opened_at, reason) VALUES (?, ?, ?)').bind(
        monitor.id,
        now,
        reason,
      ),
    )
  if (next.change === 'up')
    statements.push(
      env.DB.prepare('UPDATE incidents SET closed_at = ? WHERE monitor_id = ? AND closed_at IS NULL').bind(
        now,
        monitor.id,
      ),
    )
  // Recovering unmutes it, and says so
  if (next.change === 'up' && monitor.muted_at)
    statements.push(env.DB.prepare('UPDATE monitors SET muted_at = NULL WHERE id = ?').bind(monitor.id))
  await env.DB.batch(statements)
  if (!next.change || (next.change === 'down' && monitor.muted_at)) return undefined
  const project = await env.DB.prepare('SELECT id, slug, name FROM projects WHERE id = ?')
    .bind(monitor.project_id)
    .first<Notice['project']>()
  if (!project) return undefined
  return {
    kind: next.change === 'down' ? 'monitor_down' : 'monitor_up',
    project,
    issue: {
      id: monitor.id,
      title:
        next.change === 'down'
          ? `${monitor.name} ${REASONS[reason] ? REASONS[reason] : 'is down'}`
          : `${monitor.name} recovered`,
      culprit: REASONS[reason] ? REASONS[reason][0].toUpperCase() + REASONS[reason].slice(1) : reason,
      level: next.change === 'down' ? 'error' : 'info',
      count: next.failures,
    },
    event: { environment: monitor.environment, level: next.change === 'down' ? 'error' : 'info' },
    url: `${env.PUBLIC_URL ?? ''}/monitors/${monitor.id}`,
  }
}

type CheckIn = {
  check_in_id?: string
  monitor_slug?: string
  status?: string
  duration?: number // seconds
  release?: string
  environment?: string
  contexts?: { trace?: { trace_id?: string } }
  monitor_config?: {
    schedule?: { type?: string; value?: string | number; unit?: string }
    checkin_margin?: number
    max_runtime?: number
    timezone?: string
    failure_issue_threshold?: number
    recovery_threshold?: number
  }
}

function configOf(raw: CheckIn['monitor_config']): CronConfig | undefined {
  const s = raw?.schedule
  if (!s) return undefined
  const schedule: Schedule | undefined =
    s.type === 'crontab' && typeof s.value === 'string'
      ? { type: 'crontab', value: s.value }
      : s.type === 'interval' && typeof s.value === 'number' && s.unit
        ? { type: 'interval', value: s.value, unit: s.unit as Extract<Schedule, { type: 'interval' }>['unit'] }
        : undefined
  if (!schedule) return undefined
  nextRun(schedule, Date.now(), raw?.timezone) // throws on a schedule that can't be read
  return { schedule, timezone: raw?.timezone, checkinMargin: raw?.checkin_margin, maxRuntime: raw?.max_runtime }
}

const slugOk = (s: unknown): s is string => typeof s === 'string' && /^[\w.-]{1,100}$/.test(s)

/** A check-in id as stored: 32 hex; Relay's nil id (an HTTP check-in that named none) is none */
const idOf = (v: unknown) => {
  if (typeof v !== 'string' || !/^[0-9a-f-]{32,36}$/i.test(v)) return undefined
  const id = v.replace(/-/g, '').toLowerCase()
  return /^0+$/.test(id) ? undefined : id
}

/**
 * A check-in from an SDK or over HTTP. Makes the monitor from its config the first time, as Sentry does. One without
 * an id (HTTP's `?status=ok` after `?status=in_progress`) finishes the monitor's latest run in progress, as Sentry
 * pairs them; else it's a check-in of its own with `fallbackId`, the same on every try of its envelope. A retry finds
 * the row its first try wrote
 */
export async function recordCheckIn(
  env: Env,
  projectId: number,
  payload: CheckIn,
  now: number,
  fallbackId?: string,
): Promise<Notice | undefined> {
  if (!slugOk(payload.monitor_slug)) return undefined
  const config = configOf(payload.monitor_config)
  let monitor = await env.DB.prepare("SELECT * FROM monitors WHERE project_id = ? AND slug = ? AND kind = 'cron'")
    .bind(projectId, payload.monitor_slug)
    .first<MonitorRow>()
  if (!monitor && !config) return undefined // Sentry ignores check-ins for monitors it doesn't know, without a config
  const thresholds = [
    payload.monitor_config?.failure_issue_threshold ?? 1,
    payload.monitor_config?.recovery_threshold ?? 1,
  ]
  if (!monitor) {
    // A project makes at most this many from check-ins, so a DSN can't fill the cron with monitors
    const made = await env.DB.prepare("SELECT COUNT(*) AS n FROM monitors WHERE project_id = ? AND kind = 'cron'")
      .bind(projectId)
      .first<{ n: number }>()
    if ((made?.n ?? 0) >= MAX_CRON_MONITORS) return undefined
    // An uptime check with the slug is left alone: no row comes back, and the check-in is dropped
    monitor = await env.DB.prepare(
      `INSERT INTO monitors (project_id, slug, name, kind, config, failure_threshold, recovery_threshold, environment, created_at)
       VALUES (?, ?, ?, 'cron', ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, slug) DO UPDATE SET config = excluded.config WHERE monitors.kind = 'cron' RETURNING *`,
    )
      .bind(
        projectId,
        payload.monitor_slug,
        payload.monitor_slug,
        JSON.stringify(config),
        ...thresholds,
        payload.environment ?? 'production',
        now,
      )
      .first<MonitorRow>()
  } else if (config && JSON.stringify(config) !== monitor.config) {
    await env.DB.prepare('UPDATE monitors SET config = ?, failure_threshold = ?, recovery_threshold = ? WHERE id = ?')
      .bind(JSON.stringify(config), ...thresholds, monitor.id)
      .run()
    monitor = {
      ...monitor,
      config: JSON.stringify(config),
      failure_threshold: thresholds[0],
      recovery_threshold: thresholds[1],
    }
  }
  if (!monitor || monitor.status === 'paused') return undefined
  const cron = JSON.parse(monitor.config) as CronConfig
  const status = ['in_progress', 'ok', 'error'].includes(payload.status ?? '') ? payload.status! : 'ok'
  const given = idOf(payload.check_in_id)
  // The run it finishes: the latest in progress. A retry has the same `now` (when its envelope came), so the run its
  // first try finished, or the check-in of its own it wrote, has `finished = now` and is found again, the id chosen once
  const open =
    !given && status !== 'in_progress'
      ? await env.DB.prepare(
          `SELECT id FROM check_ins WHERE monitor_id = ? AND started <= ? AND (status = 'in_progress' OR finished = ?)
           ORDER BY finished = ? DESC, started DESC LIMIT 1`,
        )
          .bind(monitor.id, now, now, now)
          .first<{ id: string }>()
      : null
  const id = given ?? open?.id ?? fallbackId ?? crypto.randomUUID().replace(/-/g, '')
  const duration = typeof payload.duration === 'number' ? Math.round(payload.duration * 1000) : null
  const traceId = payload.contexts?.trace?.trace_id
  const environment = payload.environment ?? null
  const statements = [
    env.DB.prepare(
      `INSERT INTO check_ins (id, monitor_id, status, started, finished, duration, release, environment, trace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET status = excluded.status, finished = excluded.finished,
       duration = COALESCE(excluded.duration, excluded.finished - check_ins.started),
       release = COALESCE(check_ins.release, excluded.release),
       environment = COALESCE(check_ins.environment, excluded.environment),
       trace_id = COALESCE(check_ins.trace_id, excluded.trace_id)
     WHERE check_ins.monitor_id = excluded.monitor_id`,
    ).bind(
      id,
      monitor.id,
      status,
      now,
      status === 'in_progress' ? null : now,
      duration,
      payload.release ?? null,
      environment,
      typeof traceId === 'string' && /^[0-9a-f]{32}$/.test(traceId) ? traceId : null,
    ),
    // Its state in the environment it came from: a check-in is the latest word there
    env.DB.prepare(
      `INSERT INTO monitor_environments (monitor_id, environment, status, last_check_in) VALUES (?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET status = excluded.status, last_check_in = excluded.last_check_in`,
    ).bind(monitor.id, (environment ?? monitor.environment).slice(0, 64), status === 'error' ? 'failing' : status, now),
  ]
  await env.DB.batch(statements)
  const nextDue = dueAfter(cron, now)
  if (status === 'in_progress') {
    await env.DB.prepare('UPDATE monitors SET next_due = ?, last_seen = ? WHERE id = ?')
      .bind(nextDue, now, monitor.id)
      .run()
    return undefined
  }
  return apply(env, monitor, status === 'ok', status, now, nextDue)
}

/** A response's text up to `max` bytes, the rest never read */
async function textUpTo(response: Response, max: number) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < max) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
  }
  await reader.cancel()
  const all = new Uint8Array(Math.min(size, max))
  let at = 0
  for (const c of chunks) {
    all.set(c.subarray(0, all.length - at), at)
    at += Math.min(c.byteLength, all.length - at)
  }
  return new TextDecoder().decode(all)
}

const hex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')

/** A JSON path as `$.a.b[0].c` (or without the `$.`), read from a value; undefined where it leads nowhere */
export function atPath(value: unknown, path: string): unknown {
  const parts = path
    .replace(/^\$\.?/, '')
    .split(/\.|\[(\d+)\]/)
    .filter((p) => p !== undefined && p !== '')
  let at: unknown = value
  for (const p of parts) {
    if (at === null || typeof at !== 'object') return undefined
    at = (at as Record<string, unknown>)[p]
  }
  return at
}

/** What's wrong with an answer, by the assertions, or undefined when it's fine */
function failed(a: Assertion, response: Response, json: () => unknown): string | undefined {
  if (a.kind === 'status')
    return a.in.includes(response.status) ? undefined : `returned HTTP ${response.status}, not ${a.in.join(' or ')}`
  if (a.kind === 'header') {
    const value = response.headers.get(a.name)
    return value?.includes(a.contains) ? undefined : `the ${a.name} header didn’t contain “${a.contains}”`
  }
  const found = atPath(json(), a.path)
  const text = found === undefined ? undefined : typeof found === 'string' ? found : JSON.stringify(found)
  return text === a.equals
    ? undefined
    : text === undefined
      ? `the response had nothing at ${a.path}`
      : `${a.path} was “${text.slice(0, 80)}”, not “${a.equals}”`
}

/**
 * One uptime check: the request with its method, headers and body (and a `sentry-trace` header, as Sentry's uptime
 * checks send, so the server's own SDK can tie its work to it), how long it took, and whether it answered as it should
 */
export async function check(config: UptimeConfig, fetcher: typeof fetch = fetch) {
  const started = Date.now()
  const method = config.method ?? 'GET'
  try {
    const headers = new Headers(config.headers ?? [])
    if (!headers.has('user-agent')) headers.set('user-agent', 'crashyard uptime check')
    headers.set('sentry-trace', `${hex(16)}-${hex(8)}-0`)
    const response = await fetcher(config.url, {
      method,
      redirect: 'follow',
      headers,
      body: BODY_METHODS.has(method) && config.body ? config.body : undefined,
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
    })
    const ms = Date.now() - started
    const assertions = config.assertions ?? []
    const statusOk = assertions.some((a) => a.kind === 'status')
      ? true
      : config.expectedStatus
        ? response.status === config.expectedStatus
        : response.ok
    let error = statusOk ? undefined : `returned HTTP ${response.status}`
    const needsBody = !!config.mustContain || assertions.some((a) => a.kind === 'json')
    const body = needsBody && method !== 'HEAD' ? await textUpTo(response, MAX_BODY) : undefined
    if (!needsBody) await response.body?.cancel()
    if (!error && config.mustContain && !body?.includes(config.mustContain))
      error = `the response didn’t contain “${config.mustContain}”`
    let parsed: { value: unknown } | undefined
    const json = () => {
      if (!parsed)
        try {
          parsed = { value: JSON.parse(body ?? '') }
        } catch {
          parsed = { value: undefined }
        }
      return parsed.value
    }
    for (const a of assertions) error ??= failed(a, response, json)
    return { ok: !error, status: response.status, ms, error }
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    return {
      ok: false,
      status: null,
      ms: Date.now() - started,
      error: timedOut ? 'timed out' : `didn’t respond: ${e instanceof Error ? e.message : e}`,
    }
  }
}

/** The minute's job: missed check-ins, runs that took too long, and the uptime checks due. Returns notices */
export async function runMonitors(
  env: Env,
  now: number,
  fetcher: typeof fetch = fetch,
  deadline = Date.now() + 40_000,
): Promise<Notice[]> {
  // What's left past the cron's deadline stays due, and runs next minute
  const late = () => Date.now() > deadline
  const notices: Notice[] = []
  const due = (
    await env.DB.prepare("SELECT * FROM monitors WHERE status != 'paused' AND next_due IS NOT NULL AND next_due <= ?")
      .bind(now)
      .all<MonitorRow>()
  ).results

  for (const monitor of due.filter((m) => m.kind === 'cron')) {
    if (late()) break
    const cron = JSON.parse(monitor.config) as CronConfig
    await env.DB.prepare("INSERT INTO check_ins (id, monitor_id, status, started) VALUES (?, ?, 'missed', ?)")
      .bind(crypto.randomUUID().replace(/-/g, ''), monitor.id, monitor.next_due)
      .run()
    const n = await apply(env, monitor, false, 'missed', now, dueAfter(cron, now))
    if (n) notices.push(n)
  }

  // In progress past their max runtime (30 minutes unless the config says)
  const open = (
    await env.DB.prepare(
      `SELECT c.id AS check_in, c.started, m.* FROM check_ins c JOIN monitors m ON m.id = c.monitor_id
       WHERE c.status = 'in_progress' AND m.status != 'paused' AND c.started < ?`,
    )
      .bind(now - MINUTE)
      .all<MonitorRow & { check_in: string; started: number }>()
  ).results
  for (const row of open) {
    if (late()) break
    const maxRuntime = ((JSON.parse(row.config) as CronConfig).maxRuntime ?? 30) * MINUTE
    if (now - row.started < maxRuntime) continue
    await env.DB.prepare("UPDATE check_ins SET status = 'timeout', finished = ? WHERE id = ?")
      .bind(now, row.check_in)
      .run()
    const { check_in: _, started: __, ...monitor } = row
    const fresh = await env.DB.prepare('SELECT * FROM monitors WHERE id = ?').bind(monitor.id).first<MonitorRow>()
    const n = await apply(env, fresh!, false, 'timeout', now, fresh!.next_due)
    if (n) notices.push(n)
  }

  // Failing for 14 days: muted, with no alerts until it recovers (apply), as Sentry's crons
  await env.DB.prepare(
    `UPDATE monitors SET muted_at = ? WHERE status = 'failing' AND muted_at IS NULL AND id IN
       (SELECT monitor_id FROM incidents WHERE closed_at IS NULL AND opened_at <= ?)`,
  )
    .bind(now, now - MUTE_AFTER)
    .run()

  // A few at a time: a Worker keeps 6 connections open and queues the rest, and a check's time and timeout start
  // when its request does, so one waiting behind slow sites isn't timed out
  const uptime = due.filter((m) => m.kind === 'uptime')
  const one = async (monitor: MonitorRow) => {
    const config = JSON.parse(monitor.config) as UptimeConfig
    const result = await check(config, fetcher)
    await env.DB.prepare(
      'INSERT OR REPLACE INTO uptime_results (monitor_id, at, ok, status, ms, error) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(monitor.id, now, result.ok ? 1 : 0, result.status, result.ms, result.error ?? null)
      .run()
    const n = await apply(env, monitor, result.ok, result.error ?? 'ok', now, now + config.intervalMinutes * MINUTE)
    if (n) notices.push(n)
  }
  await Promise.all(
    Array.from({ length: Math.min(UPTIME_AT_ONCE, uptime.length) }, async () => {
      for (let m = uptime.shift(); m && !late(); m = uptime.shift()) await one(m)
    }),
  )
  return notices
}

/** The daily cron: uptime results after 30 days, check-ins after 90 */
export async function pruneMonitors(db: D1Database, now: number) {
  await db.batch([
    db.prepare('DELETE FROM uptime_results WHERE at < ?').bind(now - 30 * 1440 * MINUTE),
    db.prepare('DELETE FROM check_ins WHERE started < ?').bind(now - 90 * 1440 * MINUTE),
  ])
}
