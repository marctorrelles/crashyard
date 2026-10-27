// Cloudflare Workers that name crashyard in their `tail_consumers`: each run's outcome comes to `tail()`, including
// the ones the Sentry SDK never sees (out of CPU time or memory). A failed run becomes an event for every project
// that lists the Worker, sent through ingest as an envelope with the project's own key, so quotas, filters, grouping,
// notices and retries are the envelope's.
import { WORKERS_KEY } from '../data/settings'
import type { IngestEnv } from './ingest'

type Json = Record<string, unknown>

// What a run that hit a limit is called: Cloudflare's outcome, as the exception's type and value
const LIMITS: Record<string, [type: string, value: string]> = {
  exceededCpu: ['ExceededCpu', 'The Worker ran out of CPU time'],
  exceededMemory: ['ExceededMemory', 'The Worker ran out of memory'],
}

const LEVELS: Record<string, string> = { log: 'info', info: 'info', debug: 'debug', warn: 'warning', error: 'error' }

/** A V8 stack as Sentry frames, oldest first */
export function framesOf(stack: string | undefined) {
  return (stack ?? '')
    .split('\n')
    .map((line) => line.match(/^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/))
    .filter((m) => m !== null)
    .map(([, fn, file, line, column]) => ({
      function: fn,
      filename: file,
      lineno: Number(line),
      colno: Number(column),
      in_app: !file.includes('node_modules'),
    }))
    .reverse()
}

const text = (message: unknown) =>
  (Array.isArray(message) ? message : [message]).map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join(' ')

/** What ran: a request, a cron, a queue batch, an alarm */
function runOf(event: TraceItem['event']): { name?: string; request?: Json } {
  const e = (event ?? {}) as Json
  const request = e.request as { url: string; method: string; headers: Record<string, string> } | undefined
  if (request) {
    const url = new URL(request.url)
    return {
      name: `${request.method} ${url.pathname}`,
      request: { url: request.url, method: request.method, headers: request.headers },
    }
  }
  if (typeof e.cron === 'string') return { name: `cron ${e.cron}` }
  if (typeof e.queue === 'string') return { name: `queue ${e.queue}` }
  if (e.scheduledTime instanceof Date) return { name: 'alarm' }
  return {}
}

/** A failed run as a Sentry event, or null for one to leave: a success, or an exception the SDK already sends */
export function tailEvent(item: TraceItem, exceptions: boolean): Json | null {
  const limit = LIMITS[item.outcome]
  const thrown = item.exceptions.at(-1)
  if (!limit && !(exceptions && item.outcome === 'exception' && thrown)) return null
  const script = item.scriptName ?? 'worker'
  const run = runOf(item.event)
  const exception = limit
    ? { type: limit[0], value: limit[1], mechanism: { type: 'cloudflare.tail', handled: false } }
    : {
        type: thrown!.name,
        value: thrown!.message,
        mechanism: { type: 'cloudflare.tail', handled: false },
        stacktrace: { frames: framesOf(thrown!.stack) },
      }
  return {
    event_id: crypto.randomUUID().replace(/-/g, ''),
    timestamp: (item.eventTimestamp ?? Date.now()) / 1000,
    platform: 'javascript',
    level: limit ? 'fatal' : 'error',
    logger: 'cloudflare.tail',
    transaction: run.name,
    request: run.request,
    exception: { values: [exception] },
    // A limit groups by its Worker, whatever the request; an exception groups as any other, by its stack
    fingerprint: limit ? ['cloudflare.tail', item.outcome, script] : undefined,
    tags: {
      worker: script,
      'worker.outcome': item.outcome,
      ...(item.entrypoint && { 'worker.entrypoint': item.entrypoint }),
    },
    contexts: {
      cloudflare_worker: {
        script,
        outcome: item.outcome,
        version: item.scriptVersion?.id,
        cpu_time_ms: item.cpuTime,
        wall_time_ms: item.wallTime,
        logs_truncated: item.truncated || undefined,
      },
    },
    breadcrumbs: {
      values: item.logs.map((l) => ({
        timestamp: l.timestamp / 1000,
        category: 'console',
        level: LEVELS[l.level] ?? 'info',
        message: text(l.message).slice(0, 2000),
      })),
    },
    sdk: { name: 'crashyard.tail', version: '1' },
  }
}

// When this isolate last noted each Worker, so a busy one writes at most once an hour
const noted = new Map<string, number>()
const HOUR = 3_600_000

/**
 * Notes the Workers sending runs here, so a project's settings can list them to add with a click, and show the line
 * in their wrangler file works. One upsert, merging into the setting, for the names this isolate hasn't noted for an
 * hour: a new Worker shows up on its first run.
 */
export async function noteWorkers(db: D1Database, names: string[], now: number) {
  const due = [...new Set(names)].filter((n) => !noted.has(n) || now - noted.get(n)! >= HOUR)
  if (!due.length) return
  for (const n of due) noted.set(n, now)
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT DO UPDATE SET value = json_patch(value, excluded.value), updated_at = excluded.updated_at`,
    )
    .bind(WORKERS_KEY, JSON.stringify(Object.fromEntries(due.map((n) => [n, now]))), now)
    .run()
}

export async function handleTail(items: TraceItem[], env: IngestEnv, ctx: ExecutionContext) {
  const names = items.map((i) => i.scriptName).filter((n) => n !== null)
  ctx.waitUntil(noteWorkers(env.DB, names, Date.now()).catch((e) => console.error('noting Workers failed', e)))
  const failed = items.filter((i) => i.scriptName && (i.outcome in LIMITS || i.outcome === 'exception'))
  if (!failed.length) return
  // Loaded only for a failed run, so the many that succeed don't load ingest and its symbols
  const { handleIngest } = await import('./ingest')
  // Each project that lists one of these Workers, with its first key that's on
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.worker_exceptions, w.value AS script,
       (SELECT k.public_key FROM project_keys k WHERE k.project_id = p.id AND k.enabled = 1 ORDER BY k.id LIMIT 1) AS key
     FROM projects p, json_each(p.workers) w WHERE w.value IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify([...new Set(failed.map((i) => i.scriptName))]))
    .all<{ id: number; worker_exceptions: number; script: string; key: string | null }>()
  for (const item of failed)
    for (const project of results) {
      if (project.script !== item.scriptName || !project.key) continue
      const event = tailEvent(item, !!project.worker_exceptions)
      if (!event) continue
      const body = `${JSON.stringify({ event_id: event.event_id })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`
      const request = new Request(`https://tail.crashyard/api/${project.id}/envelope/`, {
        method: 'POST',
        headers: { 'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${project.key}` },
        body,
      })
      await handleIngest(request, env, ctx, project.id, 'envelope')
    }
}
