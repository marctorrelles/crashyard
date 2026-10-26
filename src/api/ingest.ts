// The endpoints the Sentry SDKs send to: POST /api/<project>/envelope/ (everything) and /api/<project>/store/ (an
// event alone, from older SDKs). See ../ingest/AGENTS.md for what's kept and what's answered.
import { projectKey } from '../ingest/auth'
import { BodyError, readBody } from '../ingest/body'
import { EnvelopeError, type EnvelopeItem, parseEnvelope, payloadJson } from '../ingest/envelope'
import { eventIdOf, normalizeEvent } from '../ingest/event'
import { fingerprintOf } from '../ingest/grouping'
import { normalizeLogs, storeLogs } from '../ingest/logs'
import { recordCheckIn } from '../monitors/monitors'
import { fromSpans, sessionCounts, storeSessions, storeTransaction, summarize } from '../performance/ingest'
import {
  type Endpoint,
  type Held,
  hold,
  parseTodo,
  pendingKey,
  settle,
  stableEventId,
  type Todo,
} from '../ingest/retry'
import { loadExtraFields } from '../ingest/scrub'
import { dayOf, type Project, storeEvent } from '../ingest/store'
import { sharedSymbolic } from '../symbols/module'
import { symbolicate } from '../symbols/symbolicate'
import type { Notice, Route } from '../notify/notice'
import { frequencyHits } from '../notify/rules'

export type IngestEnv = {
  DB: D1Database
  FILES: R2Bucket
  EMAIL?: SendEmail
  EMAIL_FROM?: string
  PUBLIC_URL?: string
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, content-encoding, x-sentry-auth, sentry-trace, baggage, authorization',
  'Access-Control-Expose-Headers': 'x-sentry-rate-limits, retry-after',
  'Access-Control-Max-Age': '86400',
}
const answer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...CORS, ...headers } })

const MAX_ATTACHMENT = 1024 * 1024
// The kinds of item a route or later phase handles; anything else is accepted and dropped
const KEPT = new Set([
  'event',
  'attachment',
  'feedback',
  'user_report',
  'log',
  'check_in',
  'transaction',
  'span',
  'session',
  'sessions',
])

// Projects and keys change rarely; a minute's cache spares a read per request
type Keyed = { project: Project; key: { id: number; enabled: boolean; daily_limit: number | null } }
const projects = new Map<string, { found: Keyed | null; at: number }>()
async function projectFor(db: D1Database, id: number, key: string): Promise<Keyed | null> {
  const cacheKey = `${id}:${key}`
  const hit = projects.get(cacheKey)
  if (hit && Date.now() - hit.at < 60_000) return hit.found
  const row = await db
    .prepare(
      `SELECT p.id, p.slug, p.name, p.daily_event_quota, p.daily_log_quota, p.daily_transaction_quota,
         k.id AS key_id, k.enabled, k.daily_limit
       FROM project_keys k JOIN projects p ON p.id = k.project_id WHERE k.project_id = ? AND k.public_key = ?`,
    )
    .bind(id, key)
    .first<Project & { key_id: number; enabled: number; daily_limit: number | null }>()
  const found = row && {
    project: {
      id: row.id,
      slug: row.slug,
      name: row.name,
      daily_event_quota: row.daily_event_quota,
      daily_log_quota: row.daily_log_quota,
      daily_transaction_quota: row.daily_transaction_quota,
    },
    key: { id: row.key_id, enabled: !!row.enabled, daily_limit: row.daily_limit },
  }
  projects.set(cacheKey, { found, at: Date.now() })
  return found
}

const secondsToMidnight = (now: number) => Math.ceil((86_400_000 - (now % 86_400_000)) / 1000)

export async function handleIngest(
  request: Request,
  env: IngestEnv,
  ctx: ExecutionContext,
  projectId: number,
  endpoint: Endpoint,
) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (request.method !== 'POST') return answer({ detail: 'Method not allowed' }, 405)
  const url = new URL(request.url)
  const now = Date.now()

  let body: Uint8Array
  try {
    body = await readBody(request)
  } catch (error) {
    if (error instanceof BodyError) return answer({ detail: error.message }, error.status)
    throw error
  }

  let items: EnvelopeItem[]
  let envelopeId: string | undefined
  let key: string | null
  if (endpoint === 'envelope') {
    try {
      const envelope = parseEnvelope(body)
      items = envelope.items
      envelopeId = eventIdOf(envelope.header.event_id)
      key = projectKey(request, url, envelope.header.dsn)
    } catch (error) {
      if (error instanceof EnvelopeError) return answer({ detail: error.message }, 400)
      throw error
    }
  } else {
    items = [{ header: { type: 'event' }, payload: body }]
    key = projectKey(request, url)
  }
  if (!key) return answer({ detail: 'Missing project key' }, 401)
  const found = await projectFor(env.DB, projectId, key)
  if (!found) return answer({ detail: 'Invalid DSN' }, 403)
  // Relay's answer to a key that's turned off
  if (!found.key.enabled) return answer({ detail: 'event submission rejected with_reason: ProjectId' }, 403)
  const { project } = found

  // The project's daily quotas, events and logs apart, and its key's daily event limit: past one, the SDK is told
  // when to try that kind again, as Sentry tells it (X-Sentry-Rate-Limits, by category and scope); an envelope with
  // nothing left to keep gets a 429
  const [today, keyToday] = await env.DB.batch<{ events: number; logs?: number; transactions?: number }>([
    env.DB.prepare('SELECT events, logs, transactions FROM project_days WHERE project_id = ? AND day = ?').bind(
      project.id,
      dayOf(now),
    ),
    env.DB.prepare('SELECT events FROM key_days WHERE key_id = ? AND day = ?').bind(found.key.id, dayOf(now)),
  ])
  const day = today.results[0]
  const keyOver = found.key.daily_limit !== null && (keyToday.results[0]?.events ?? 0) >= found.key.daily_limit
  const exceeded = {
    events: (day?.events ?? 0) >= project.daily_event_quota,
    logs: (day?.logs ?? 0) >= project.daily_log_quota,
    transactions: (day?.transactions ?? 0) >= project.daily_transaction_quota,
  }
  // Check-ins and sessions are few, and say something's alive: no quota
  const over = (type: string) =>
    type === 'check_in' || type === 'session' || type === 'sessions'
      ? false
      : type === 'log'
        ? exceeded.logs
        : type === 'transaction' || type === 'span'
          ? exceeded.transactions
          : exceeded.events || keyOver
  const retry = String(secondsToMidnight(now))
  const ERRORS = 'error;default;security;attachment;feedback'
  const categories = [
    exceeded.events && ERRORS,
    exceeded.logs && 'log_item',
    exceeded.transactions && 'transaction;span',
  ].filter(Boolean)
  const limits =
    [
      categories.length
        ? exceeded.events && exceeded.logs && exceeded.transactions
          ? `${retry}::organization:usage_exceeded`
          : `${retry}:${categories.join(';')}:organization:usage_exceeded`
        : undefined,
      keyOver && !exceeded.events ? `${retry}:${ERRORS}:key:key_quota` : undefined,
    ]
      .filter(Boolean)
      .join(', ') || undefined
  const kept = items.filter((i) => KEPT.has(i.header.type ?? 'event'))
  if (limits && kept.length && kept.every((i) => over(i.header.type ?? 'event'))) {
    ctx.waitUntil(
      env.DB.prepare(
        'INSERT INTO project_days (project_id, day, dropped) VALUES (?, ?, 1) ON CONFLICT DO UPDATE SET dropped = dropped + 1',
      )
        .bind(project.id, dayOf(now))
        .run(),
    )
    return answer({ detail: 'Daily quota reached' }, 429, { 'Retry-After': retry, 'X-Sentry-Rate-Limits': limits })
  }

  // Held in R2 while it's processed, so what fails is tried again by the cron (src/ingest/retry.ts); the items to do
  // are listed only when the quota left some out
  const todo = items.flatMap((item, i) => {
    const type = item.header.type ?? 'event'
    return KEPT.has(type) && !over(type) ? [String(i)] : []
  })
  // The key's events today, counted as they're let in, so a retry doesn't count them again
  const events = todo.filter((i) => (items[Number(i)].header.type ?? 'event') === 'event').length
  if (events)
    ctx.waitUntil(
      env.DB.prepare(
        'INSERT INTO key_days (key_id, day, events) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET events = events + excluded.events',
      )
        .bind(found.key.id, dayOf(now), events)
        .run(),
    )
  const held = todo.length
    ? await hold(env.FILES, pendingKey(project.id, now), body, endpoint, todo.length < kept.length ? todo : undefined)
    : undefined
  let result: Awaited<ReturnType<typeof processItems>>
  try {
    result = await processItems(
      {
        env,
        origin: url.origin,
        project,
        endpoint,
        received: now,
        envelopeId,
        held,
        body,
        waitUntil: (p) => ctx.waitUntil(p),
      },
      items,
      parseTodo(todo),
    )
  } catch (error) {
    if (!(error instanceof EnvelopeError)) throw error
    if (held) ctx.waitUntil(env.FILES.delete(held))
    return answer({ detail: error.message }, 400)
  }
  // Relay's way: accepted before it's processed, so a failure still answers 200, and the cron tries it again
  if (held)
    ctx.waitUntil(
      settle(env, { key: held, projectId: project.id, received: now, endpoint }, body, 1, result.failed, now),
    )
  const { notices, eventId } = result
  if (notices.length) ctx.waitUntil(import('../notify/dispatch').then(({ dispatch }) => dispatch(env, notices)))
  const headers: Record<string, string> = limits ? { 'X-Sentry-Rate-Limits': limits } : {}
  return endpoint === 'store'
    ? answer({ id: eventId }, 200, headers)
    : answer(eventId ? { id: eventId } : {}, 200, headers)
}

type Pass = {
  env: IngestEnv
  origin: string
  project: Project
  endpoint: Endpoint
  received: number
  envelopeId?: string
  held?: string
  body: Uint8Array
  waitUntil: (promise: Promise<unknown>) => void
}

/**
 * The items in `todo` (index, and where to start in a span item), each in its own try: what fails is listed for a
 * retry and the rest goes on. An envelope that isn't one throws EnvelopeError. Both the request and the cron's retry
 * come through here, so a retry stores what the request would have.
 */
async function processItems(c: Pass, items: EnvelopeItem[], todo: Map<number, number>) {
  const { env, project, received: now } = c
  await loadExtraFields(env.DB)
  const notices: Notice[] = []
  const failed: Todo = []
  let firstEventId: string | undefined
  const attachments: [number, EnvelopeItem][] = []
  for (const [index, from] of todo) {
    const item = items[index]
    if (!item) continue
    const type = item.header.type ?? 'event'
    if (type === 'attachment') {
      attachments.push([index, item])
      continue
    }
    let done = from
    try {
      if (type === 'span') {
        const spans = fromSpans(payloadJson(item))
        for (; done < spans.length; done++) {
          const summary = summarize(spans[done], now)
          if (summary) await storeTransaction(env.DB, project.id, summary, now)
        }
      } else if (type === 'transaction') {
        const summary = summarize(payloadJson(item), now)
        if (summary) await storeTransaction(env.DB, project.id, summary, now)
      } else if (type === 'session' || type === 'sessions') {
        await storeSessions(env.DB, project.id, sessionCounts(type, payloadJson(item), now))
      } else if (type === 'check_in') {
        const notice = await recordCheckIn({ ...env, PUBLIC_URL: c.origin }, project.id, payloadJson(item), now)
        if (notice) notices.push(notice)
      } else if (type === 'log') {
        await storeLogs(env.DB, project.id, normalizeLogs(payloadJson(item), now), now, dayOf(now))
      } else if (type === 'event') {
        const payload = payloadJson(item)
        // An event without an id gets one that's the same on every try, so a retry finds it stored
        const fallback = c.envelopeId ?? (c.held ? stableEventId(c.held, index) : undefined)
        firstEventId ??= eventIdOf(payload.event_id) ?? fallback
        const event = await normalizeEvent(payload, now, fallback)
        // Readable stacks before grouping, so the same crash groups by its functions across builds
        await symbolicate(env, sharedSymbolic, project.id, event)
        const envelopeKey = c.endpoint === 'envelope' ? `envelopes/${project.id}/${dayOf(now)}/${event.id}` : undefined
        const stored = await storeEvent(env.DB, project, event, await fingerprintOf(event), envelopeKey)
        if (envelopeKey && stored?.stored) c.waitUntil(env.FILES.put(envelopeKey, c.body))
        if (stored) notices.push(...(await noticesFor(env, c.origin, project, event, stored)))
      } else {
        await storeFeedback(env.DB, project, type, payloadJson(item), c.envelopeId, now)
      }
    } catch (error) {
      if (error instanceof EnvelopeError) throw error
      console.error(`ingest: item ${index} (${type}) of project ${project.id} failed`, error)
      failed.push(done > 0 ? `${index}:${done}` : String(index))
    }
  }

  const eventId = c.envelopeId ?? firstEventId ?? firstEventIdOf(items, c.held)
  for (const [index, item] of attachments) {
    try {
      if (eventId) await storeAttachment(env, project, eventId, item, now)
    } catch (error) {
      console.error(`ingest: attachment ${index} of project ${project.id} failed`, error)
      failed.push(String(index))
    }
  }
  return { notices, failed, eventId }
}

/** A retry has only the items that failed: an attachment still needs the id of the envelope's event */
function firstEventIdOf(items: EnvelopeItem[], held?: string) {
  const index = items.findIndex((i) => (i.header.type ?? 'event') === 'event')
  if (index < 0) return undefined
  try {
    return eventIdOf(payloadJson(items[index]).event_id) ?? (held ? stableEventId(held, index) : undefined)
  } catch {
    return undefined
  }
}

/** The cron's retry of a held envelope: the project as it is now, the envelope as it came, only what's left to do */
export async function retryEnvelope(
  env: IngestEnv & { PUBLIC_URL?: string },
  held: Held,
  body: Uint8Array,
  todo: Todo | undefined,
): Promise<Todo> {
  const project = await env.DB.prepare(
    'SELECT id, slug, name, daily_event_quota, daily_log_quota, daily_transaction_quota FROM projects WHERE id = ?',
  )
    .bind(held.projectId)
    .first<Project>()
  if (!project) return [] // deleted since: nothing left to keep it for
  let items: EnvelopeItem[]
  let envelopeId: string | undefined
  try {
    if (held.endpoint === 'envelope') {
      const envelope = parseEnvelope(body)
      items = envelope.items
      envelopeId = eventIdOf(envelope.header.event_id)
    } else items = [{ header: { type: 'event' }, payload: body }]
  } catch {
    return [] // it parsed when it came; if it no longer does, no try will
  }
  const all = items.flatMap((item, i) => (KEPT.has(item.header.type ?? 'event') ? [String(i)] : []))
  const waits: Promise<unknown>[] = []
  let result: Awaited<ReturnType<typeof processItems>>
  try {
    result = await processItems(
      {
        env,
        origin: env.PUBLIC_URL ?? '',
        project,
        endpoint: held.endpoint,
        received: held.received,
        envelopeId,
        held: held.key,
        body,
        waitUntil: (p) => void waits.push(p),
      },
      items,
      parseTodo(todo ?? all),
    )
  } catch (error) {
    if (error instanceof EnvelopeError) return []
    throw error
  }
  await Promise.allSettled(waits)
  if (result.notices.length) await (await import('../notify/dispatch')).dispatch(env, result.notices)
  return result.failed
}

type Stored = NonNullable<Awaited<ReturnType<typeof storeEvent>>>

async function noticesFor(
  env: IngestEnv,
  origin: string,
  project: Project,
  event: Awaited<ReturnType<typeof normalizeEvent>>,
  stored: Stored,
) {
  const base = {
    project: { id: project.id, slug: project.slug, name: project.name },
    issue: stored.issue,
    event: {
      release: event.release,
      environment: event.environment,
      level: event.level,
      device: event.tags.device,
      os: event.tags.os,
      tags: event.tags,
    },
    url: `${origin}/issues/${stored.issue.id}`,
  }
  const notices: Notice[] = []
  // Routes with a frequency: each counts the issue's events or users in its own window (src/notify/rules.ts). On a
  // retry too, as the event is stored only then; `received` is when it came, so the window is the same
  const routes = (
    await env.DB.prepare('SELECT * FROM routes WHERE frequency IS NOT NULL AND (project_id IS NULL OR project_id = ?)')
      .bind(project.id)
      .all<Route>()
  ).results.filter((r) => r.kinds.includes('"frequency"'))
  const hits = routes.length
    ? await frequencyHits(env.DB, routes, {
        issueId: stored.issue.id,
        issueCount: stored.issue.count,
        eventId: event.id,
        received: event.received,
        userHash: event.userHash,
        kept: stored.stored,
      })
    : []
  for (const { route, rate } of hits) notices.push({ ...base, kind: 'frequency', routeId: route.id, rate })
  if (stored.isNew) notices.push({ ...base, kind: 'new' })
  if (stored.transition === 'regressed') notices.push({ ...base, kind: 'regression' })
  if (stored.transition === 'ignore_expired') notices.push({ ...base, kind: 'ignore_expired' })
  // Each route checks its own thresholds against the count before and after (thresholdFor)
  if (!stored.isNew) notices.push({ ...base, kind: 'threshold', countBefore: stored.countBefore })
  // Where a build came from (the app sets the tag): a crash in App Review or TestFlight, the first time per issue
  const distribution = event.tags.distribution
  if (distribution === 'app_review' || distribution === 'testflight') {
    const seen = await env.DB.prepare("SELECT 1 FROM issue_activity WHERE issue_id = ? AND kind = 'review_crash'")
      .bind(stored.issue.id)
      .first()
    if (!seen) {
      await env.DB.prepare("INSERT INTO issue_activity (issue_id, kind, data, at) VALUES (?, 'review_crash', ?, ?)")
        .bind(stored.issue.id, JSON.stringify({ eventId: event.id, distribution }), event.received)
        .run()
      notices.push({ ...base, kind: 'review_crash' })
    }
  }
  return notices
}

async function storeFeedback(
  db: D1Database,
  project: Project,
  type: string,
  payload: Record<string, unknown>,
  envelopeId: string | undefined,
  now: number,
) {
  // `feedback` (current SDKs): an event whose contexts.feedback holds the message; `user_report` (older): its own shape
  const fb =
    type === 'feedback'
      ? ((payload.contexts as Record<string, Record<string, unknown>> | undefined)?.feedback ?? {})
      : payload
  const message = String(fb.message ?? fb.comments ?? '').slice(0, 5000)
  if (!message) return
  const eventId = eventIdOf(fb.associated_event_id ?? payload.event_id ?? envelopeId)
  const issue = eventId
    ? await db.prepare('SELECT issue_id FROM events WHERE id = ?').bind(eventId).first<{ issue_id: number }>()
    : null
  await db
    .prepare('INSERT INTO feedback (project_id, issue_id, event_id, name, message, at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(
      project.id,
      issue?.issue_id ?? null,
      eventId ?? null,
      typeof fb.name === 'string' ? fb.name.slice(0, 200) : null,
      message,
      now,
    )
    .run()
}

async function storeAttachment(env: IngestEnv, project: Project, eventId: string, item: EnvelopeItem, now: number) {
  if (item.payload.byteLength > MAX_ATTACHMENT) return
  const filename = String(item.header.filename ?? 'attachment')
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 100)
  const key = `attachments/${project.id}/${eventId}/${filename}`
  await env.FILES.put(key, item.payload, {
    httpMetadata: { contentType: String(item.header.content_type ?? 'application/octet-stream') },
  })
  await env.DB.prepare(
    'INSERT INTO attachments (event_id, project_id, filename, content_type, size, r2_key, received) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(eventId, project.id, filename, String(item.header.content_type ?? ''), item.payload.byteLength, key, now)
    .run()
}
