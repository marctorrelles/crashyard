// Monitors at work: check-ins as they arrive, and the minute's job (missed runs, runs that took too long, uptime
// checks). Each result moves the monitor's count of failures or successes in a row; crossing its threshold opens
// or closes an incident, and tells the routes (`monitor_down`, `monitor_up`).
import type { Notice } from '../notify/notice'
import { nextRun, type Schedule } from './schedule'

export type CronConfig = { schedule: Schedule; timezone?: string; checkinMargin?: number; maxRuntime?: number }
export type UptimeConfig = {
  url: string
  method?: string
  expectedStatus?: number // or any 2xx
  mustContain?: string
  intervalMinutes: number
  timeoutMs?: number
}

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
}

type Env = { DB: D1Database; PUBLIC_URL?: string }
const MINUTE = 60_000

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
  await env.DB.batch(statements)
  if (!next.change) return undefined
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
 * pairs them; else it's a check-in of its own with `fallbackId`, the same on every try of its envelope
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
    monitor = await env.DB.prepare(
      `INSERT INTO monitors (project_id, slug, name, kind, config, failure_threshold, recovery_threshold, environment, created_at)
       VALUES (?, ?, ?, 'cron', ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET config = excluded.config RETURNING *`,
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
  const open =
    !given && status !== 'in_progress'
      ? await env.DB.prepare(
          "SELECT id FROM check_ins WHERE monitor_id = ? AND status = 'in_progress' ORDER BY started DESC LIMIT 1",
        )
          .bind(monitor.id)
          .first<{ id: string }>()
      : null
  const id = given ?? open?.id ?? fallbackId ?? crypto.randomUUID().replace(/-/g, '')
  const duration = typeof payload.duration === 'number' ? Math.round(payload.duration * 1000) : null
  await env.DB.prepare(
    `INSERT INTO check_ins (id, monitor_id, status, started, finished, duration, release, environment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET status = excluded.status, finished = excluded.finished,
       duration = COALESCE(excluded.duration, excluded.finished - check_ins.started),
       release = COALESCE(check_ins.release, excluded.release),
       environment = COALESCE(check_ins.environment, excluded.environment)`,
  )
    .bind(
      id,
      monitor.id,
      status,
      now,
      status === 'in_progress' ? null : now,
      duration,
      payload.release ?? null,
      payload.environment ?? null,
    )
    .run()
  const nextDue = dueAfter(cron, now)
  if (status === 'in_progress') {
    await env.DB.prepare('UPDATE monitors SET next_due = ?, last_seen = ? WHERE id = ?')
      .bind(nextDue, now, monitor.id)
      .run()
    return undefined
  }
  return apply(env, monitor, status === 'ok', status, now, nextDue)
}

/** One uptime check: the request, how long it took, and whether it answered as it should */
export async function check(config: UptimeConfig, fetcher: typeof fetch = fetch) {
  const started = Date.now()
  try {
    const response = await fetcher(config.url, {
      method: config.method ?? 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'crashyard uptime check' },
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
    })
    const ms = Date.now() - started
    const statusOk = config.expectedStatus ? response.status === config.expectedStatus : response.ok
    let error = statusOk ? undefined : `returned HTTP ${response.status}`
    if (statusOk && config.mustContain) {
      const body = (await response.text()).slice(0, 1024 * 1024)
      if (!body.includes(config.mustContain)) error = `the response didn’t contain “${config.mustContain}”`
    } else {
      await response.body?.cancel()
    }
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
export async function runMonitors(env: Env, now: number, fetcher: typeof fetch = fetch): Promise<Notice[]> {
  const notices: Notice[] = []
  const due = (
    await env.DB.prepare("SELECT * FROM monitors WHERE status != 'paused' AND next_due IS NOT NULL AND next_due <= ?")
      .bind(now)
      .all<MonitorRow>()
  ).results

  for (const monitor of due.filter((m) => m.kind === 'cron')) {
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

  // ponytail: every due check at once; a concurrency limit if a deployment has hundreds
  const results = await Promise.all(
    due
      .filter((m) => m.kind === 'uptime')
      .map(async (monitor) => {
        const config = JSON.parse(monitor.config) as UptimeConfig
        const result = await check(config, fetcher)
        await env.DB.prepare(
          'INSERT OR REPLACE INTO uptime_results (monitor_id, at, ok, status, ms, error) VALUES (?, ?, ?, ?, ?, ?)',
        )
          .bind(monitor.id, now, result.ok ? 1 : 0, result.status, result.ms, result.error ?? null)
          .run()
        return apply(env, monitor, result.ok, result.error ?? 'ok', now, now + config.intervalMinutes * MINUTE)
      }),
  )
  notices.push(...results.filter((n): n is Notice => !!n))
  return notices
}

/** The daily cron: uptime results after 30 days, check-ins after 90 */
export async function pruneMonitors(db: D1Database, now: number) {
  await db.batch([
    db.prepare('DELETE FROM uptime_results WHERE at < ?').bind(now - 30 * 1440 * MINUTE),
    db.prepare('DELETE FROM check_ins WHERE started < ?').bind(now - 90 * 1440 * MINUTE),
  ])
}
