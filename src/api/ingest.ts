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
import { dayOf, type Project, storeEvent } from '../ingest/store'
import { actionUrl } from '../notify/actions'
import { sharedSymbolic } from '../symbols/module'
import { symbolicate } from '../symbols/symbolicate'
import type { Notice } from '../notify/notice'

export type IngestEnv = {
  DB: D1Database
  FILES: R2Bucket
  ACTION_SECRET?: string
  EMAIL?: SendEmail
  EMAIL_FROM?: string
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

// Projects change rarely; a minute's cache spares a read per request
const projects = new Map<string, { project: Project | null; at: number }>()
async function projectFor(db: D1Database, id: number, key: string): Promise<Project | null> {
  const cacheKey = `${id}:${key}`
  const hit = projects.get(cacheKey)
  if (hit && Date.now() - hit.at < 60_000) return hit.project
  const project = await db
    .prepare(
      'SELECT id, slug, name, public_key, daily_event_quota, daily_log_quota, daily_transaction_quota FROM projects WHERE id = ? AND public_key = ?',
    )
    .bind(id, key)
    .first<Project>()
  projects.set(cacheKey, { project, at: Date.now() })
  return project
}

const secondsToMidnight = (now: number) => Math.ceil((86_400_000 - (now % 86_400_000)) / 1000)

export async function handleIngest(
  request: Request,
  env: IngestEnv,
  ctx: ExecutionContext,
  projectId: number,
  endpoint: 'envelope' | 'store',
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
  const project = await projectFor(env.DB, projectId, key)
  if (!project) return answer({ detail: 'Invalid DSN' }, 403)

  // The project's daily quotas, events and logs apart: past one, the SDK is told when to try that kind again, as
  // Sentry tells it (X-Sentry-Rate-Limits, by category); an envelope with nothing left to keep gets a 429
  const today = await env.DB.prepare(
    'SELECT events, logs, transactions FROM project_days WHERE project_id = ? AND day = ?',
  )
    .bind(project.id, dayOf(now))
    .first<{ events: number; logs: number; transactions: number }>()
  const exceeded = {
    events: (today?.events ?? 0) >= project.daily_event_quota,
    logs: (today?.logs ?? 0) >= project.daily_log_quota,
    transactions: (today?.transactions ?? 0) >= project.daily_transaction_quota,
  }
  // Check-ins and sessions are few, and say something's alive: no quota
  const over = (type: string) =>
    type === 'check_in' || type === 'session' || type === 'sessions'
      ? false
      : type === 'log'
        ? exceeded.logs
        : type === 'transaction' || type === 'span'
          ? exceeded.transactions
          : exceeded.events
  const retry = String(secondsToMidnight(now))
  const categories = [
    exceeded.events && 'error;default;security;attachment;feedback',
    exceeded.logs && 'log_item',
    exceeded.transactions && 'transaction;span',
  ].filter(Boolean)
  const limits = categories.length
    ? exceeded.events && exceeded.logs && exceeded.transactions
      ? `${retry}::organization:usage_exceeded`
      : `${retry}:${categories.join(';')}:organization:usage_exceeded`
    : undefined
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

  const notices: Notice[] = []
  let firstEventId: string | undefined
  const attachments: EnvelopeItem[] = []
  for (const item of kept) {
    const type = item.header.type ?? 'event'
    if (over(type)) continue
    try {
      if (type === 'span') {
        for (const raw of fromSpans(payloadJson(item))) {
          const summary = summarize(raw, now)
          if (summary) await storeTransaction(env.DB, project.id, summary, now)
        }
      } else if (type === 'transaction') {
        const summary = summarize(payloadJson(item), now)
        if (summary) await storeTransaction(env.DB, project.id, summary, now)
      } else if (type === 'session' || type === 'sessions') {
        await storeSessions(env.DB, project.id, sessionCounts(type, payloadJson(item), now))
      } else if (type === 'check_in') {
        const notice = await recordCheckIn({ ...env, PUBLIC_URL: url.origin }, project.id, payloadJson(item), now)
        if (notice) notices.push(notice)
      } else if (type === 'log') {
        await storeLogs(env.DB, project.id, normalizeLogs(payloadJson(item), now), now, dayOf(now))
      } else if (type === 'event') {
        const event = await normalizeEvent(payloadJson(item), now, envelopeId)
        firstEventId ??= event.id
        // Readable stacks before grouping, so the same crash groups by its functions across builds
        await symbolicate(env, sharedSymbolic, project.id, event)
        const envelopeKey = endpoint === 'envelope' ? `envelopes/${project.id}/${dayOf(now)}/${event.id}` : undefined
        const stored = await storeEvent(env.DB, project, event, await fingerprintOf(event), envelopeKey)
        if (envelopeKey && stored?.stored) ctx.waitUntil(env.FILES.put(envelopeKey, body))
        if (stored) notices.push(...(await noticesFor(env, url.origin, project, event, stored)))
      } else if (type === 'attachment') {
        attachments.push(item)
      } else {
        await storeFeedback(env.DB, project, type, payloadJson(item), envelopeId, now)
      }
    } catch (error) {
      if (error instanceof EnvelopeError) return answer({ detail: error.message }, 400)
      throw error
    }
  }

  const eventId = envelopeId ?? firstEventId
  if (eventId) for (const item of attachments) await storeAttachment(env, project, eventId, item)
  if (notices.length) ctx.waitUntil(import('../notify/dispatch').then(({ dispatch }) => dispatch(env, notices)))
  const headers: Record<string, string> = limits ? { 'X-Sentry-Rate-Limits': limits } : {}
  return endpoint === 'store'
    ? answer({ id: eventId }, 200, headers)
    : answer(eventId ? { id: eventId } : {}, 200, headers)
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
    },
    url: `${origin}/issues/${stored.issue.id}`,
    actions: env.ACTION_SECRET
      ? {
          resolve: await actionUrl(origin, env.ACTION_SECRET, stored.issue.id, 'resolve'),
          ignore: await actionUrl(origin, env.ACTION_SECRET, stored.issue.id, 'ignore'),
        }
      : undefined,
  }
  const notices: Notice[] = []
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

async function storeAttachment(env: IngestEnv, project: Project, eventId: string, item: EnvelopeItem) {
  if (item.payload.byteLength > MAX_ATTACHMENT) return
  const filename = String(item.header.filename ?? 'attachment')
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 100)
  const key = `attachments/${project.id}/${eventId}/${filename}`
  await env.FILES.put(key, item.payload, {
    httpMetadata: { contentType: String(item.header.content_type ?? 'application/octet-stream') },
  })
  await env.DB.prepare(
    'INSERT INTO attachments (event_id, project_id, filename, content_type, size, r2_key) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(eventId, project.id, filename, String(item.header.content_type ?? ''), item.payload.byteLength, key)
    .run()
}
