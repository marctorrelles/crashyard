// Durable ingest: every envelope is held in R2 under pending/ while it's processed, and what failed is tried again by
// the minute cron, five tries in all, before it moves to failed/ and counts in project_days.failed. See
// docs/decisions/0004-r2-and-cron-for-durable-ingest.md.

export type Endpoint = 'envelope' | 'store'
/** Item indexes still to process: `3`, or `3:2` for a span item from its third segment on */
export type Todo = string[]
export type Held = { key: string; projectId: number; received: number; endpoint: Endpoint }
/** One pass over the items in `todo` (every kept item when it's undefined); answers what failed */
export type Pass = (held: Held, body: Uint8Array, todo: Todo | undefined) => Promise<Todo>
type RetryEnv = { DB: D1Database; FILES: R2Bucket }

export const MAX_ATTEMPTS = 5
const BATCH = 50
const MIN_AGE = 2 * 60_000
const BUDGET = 20_000

const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')

export const pendingKey = (projectId: number, received: number) => `pending/${projectId}/${received}-${randomHex(8)}`

export function parseKey(key: string): Omit<Held, 'endpoint'> | null {
  const m = key.match(/^pending\/(\d+)\/(\d+)-([0-9a-f]{16})$/)
  return m ? { key, projectId: Number(m[1]), received: Number(m[2]) } : null
}

/** An event id for an event that came without one, the same on every try of its envelope */
export function stableEventId(key: string, index: number) {
  const m = key.match(/(\d+)-([0-9a-f]{16})$/)
  if (!m) return crypto.randomUUID().replace(/-/g, '')
  return `${Number(m[1]).toString(16).padStart(12, '0').slice(-12)}${m[2]}${index.toString(16).padStart(4, '0').slice(-4)}`
}

/** `3` or `3:2` as the item's index and where to start in it */
export function parseTodo(todo: Todo): Map<number, number> {
  const out = new Map<number, number>()
  for (const entry of todo) {
    const [index, from] = entry.split(':').map(Number)
    if (Number.isInteger(index) && index >= 0) out.set(index, Number.isInteger(from) && from > 0 ? from : 0)
  }
  return out
}

/** Holds the body before it's processed. Undefined when R2 refuses: the envelope is then processed without a net */
export async function hold(files: R2Bucket, key: string, body: Uint8Array, endpoint: Endpoint, todo?: Todo) {
  try {
    await files.put(key, body, { customMetadata: meta(endpoint, 0, todo) })
    return key
  } catch (error) {
    console.error('could not hold the envelope in R2', error)
    return undefined
  }
}

const meta = (endpoint: Endpoint, attempts: number, todo?: Todo): Record<string, string> =>
  todo ? { endpoint, attempts: String(attempts), items: todo.join(',') } : { endpoint, attempts: String(attempts) }

/**
 * After a pass: nothing failed and the held copy goes; something did, and it's kept with what's left to do and the
 * attempts so far, until the last, when it moves to failed/ and the project's day counts it
 */
export async function settle(
  env: RetryEnv,
  held: Held,
  body: Uint8Array,
  attempts: number,
  failed: Todo | 'all',
  now: number,
): Promise<'done' | 'pending' | 'failed'> {
  const left = failed === 'all' ? undefined : failed
  if (left && !left.length) {
    await env.FILES.delete(held.key)
    return 'done'
  }
  if (attempts < MAX_ATTEMPTS) {
    await env.FILES.put(held.key, body, { customMetadata: meta(held.endpoint, attempts, left) })
    return 'pending'
  }
  await env.FILES.put(held.key.replace(/^pending\//, 'failed/'), body, {
    customMetadata: meta(held.endpoint, attempts, left),
  })
  await env.FILES.delete(held.key)
  await env.DB.prepare(
    'INSERT INTO project_days (project_id, day, failed) VALUES (?, ?, 1) ON CONFLICT DO UPDATE SET failed = failed + 1',
  )
    .bind(held.projectId, new Date(now).toISOString().slice(0, 10))
    .run()
  return 'failed'
}

/** The minute cron: up to 50 held envelopes older than two minutes, within 20 seconds, each tried again */
export async function retryPending(
  env: RetryEnv,
  now: number,
  pass: Pass = async (held, body, todo) => (await import('../api/ingest')).retryEnvelope(env, held, body, todo),
): Promise<{ retried: number; failed: number }> {
  const until = Date.now() + BUDGET
  const listed = await env.FILES.list({ prefix: 'pending/', limit: BATCH, include: ['customMetadata'] })
  let retried = 0
  let failed = 0
  for (const { key } of listed.objects) {
    if (Date.now() > until) break
    const parsed = parseKey(key)
    if (!parsed || parsed.received > now - MIN_AGE) continue
    const object = await env.FILES.get(key)
    if (!object) continue
    const m = object.customMetadata ?? {}
    const held: Held = { ...parsed, endpoint: m.endpoint === 'store' ? 'store' : 'envelope' }
    const todo = m.items ? m.items.split(',') : undefined
    const body = new Uint8Array(await object.arrayBuffer())
    let left: Todo | 'all'
    try {
      left = await pass(held, body, todo)
    } catch (error) {
      console.error('retrying an envelope failed', key, error)
      left = todo ?? 'all'
    }
    retried++
    const attempts = (Number(m.attempts) || 0) + 1
    if ((await settle(env, held, body, attempts, left, now)) === 'failed') failed++
  }
  return { retried, failed }
}
