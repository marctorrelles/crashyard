// Durable ingest: every envelope is held while it's processed, in D1 (`held_envelopes`) when it's UTF-8 text of
// HOLD_IN_D1_MAX or less, else in R2 under pending/, and what failed is tried again by the minute cron, five tries in
// all, before it moves to R2's failed/ and counts in project_days.failed. Each try is counted before it starts, so an
// envelope that stops its worker still runs out of tries. See docs/decisions/0004-r2-and-cron-for-durable-ingest.md
// and 0006-small-envelopes-held-in-d1.md.

export type Endpoint = 'envelope' | 'store'
/** Item indexes still to process: `3`, or `3:2` for a span item from its third segment on */
export type Todo = string[]
/** Where the held copy is: a row of `held_envelopes`, or an R2 object; the key is the same either way */
export type Store = 'd1' | 'r2'
export type Held = { key: string; projectId: number; received: number; endpoint: Endpoint; store: Store }
/** One pass over the items in `todo` (every kept item when it's undefined); answers what failed */
export type Pass = (held: Held, body: Uint8Array, todo: Todo | undefined) => Promise<Todo>
type RetryEnv = { DB: D1Database; FILES: R2Bucket }

export const MAX_ATTEMPTS = 5
const BATCH = 25
const LIST_PAGE = 1000
const MIN_AGE = 2 * 60_000
/** How long a retry holds an envelope for itself, so a cron run that overlaps the last one leaves it alone */
const LEASE = 90_000
/**
 * The largest body held in D1, a quarter of its 2 MB for a value: nearly every envelope of events, logs or
 * transactions is far under it; over it are those carrying minidumps or big attachments, rare enough for R2's write
 */
export const HOLD_IN_D1_MAX = 512 * 1024

const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')

export const pendingKey = (projectId: number, received: number) => `pending/${projectId}/${received}-${randomHex(8)}`

export function parseKey(key: string): Omit<Held, 'endpoint' | 'store'> | null {
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

const fatal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

/** The body as text, when it's UTF-8 that comes back byte for byte and has no NUL; else undefined, for R2 */
function textOf(body: Uint8Array) {
  if (body.byteLength > HOLD_IN_D1_MAX || body.includes(0)) return undefined
  try {
    return fatal.decode(body)
  } catch {
    return undefined
  }
}

/**
 * Holds the body before it's processed, in D1 when it fits (one row, no R2 write), else in R2, as when D1 refuses.
 * Undefined when neither takes it: the envelope is then processed without a net
 */
export async function hold(
  env: RetryEnv,
  key: string,
  body: Uint8Array,
  endpoint: Endpoint,
  todo?: Todo,
): Promise<Held | undefined> {
  const parsed = parseKey(key)
  if (!parsed) throw new Error(`not a held envelope's key: ${key}`)
  const text = textOf(body)
  if (text !== undefined)
    try {
      // The request is the first try, counted as it starts
      await env.DB.prepare(
        'INSERT INTO held_envelopes (key, project_id, received, endpoint, attempts, items, body) VALUES (?, ?, ?, ?, 1, ?, ?)',
      )
        .bind(key, parsed.projectId, parsed.received, endpoint, todo ? todo.join(',') : null, text)
        .run()
      return { ...parsed, endpoint, store: 'd1' }
    } catch (error) {
      console.error('could not hold the envelope in D1, trying R2', error)
    }
  try {
    await env.FILES.put(key, body, { customMetadata: meta(endpoint, 1, todo) })
    return { ...parsed, endpoint, store: 'r2' }
  } catch (error) {
    console.error('could not hold the envelope in R2', error)
    return undefined
  }
}

/** Drops the held copy, as when its envelope turns out not to be one */
export const release = (env: RetryEnv, held: Held) =>
  held.store === 'd1'
    ? env.DB.prepare('DELETE FROM held_envelopes WHERE key = ?').bind(held.key).run()
    : env.FILES.delete(held.key)

const meta = (endpoint: Endpoint, attempts: number, todo?: Todo, leasedUntil?: number): Record<string, string> => ({
  endpoint,
  attempts: String(attempts),
  ...(todo ? { items: todo.join(',') } : {}),
  ...(leasedUntil ? { leased_until: String(leasedUntil) } : {}),
})

/**
 * After a pass: nothing failed and the held copy goes; something did, and it's kept with what's left to do and the
 * attempts so far, until the last, when it moves to R2's failed/ and the project's day counts it
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
    await release(env, held)
    return 'done'
  }
  if (attempts < MAX_ATTEMPTS) {
    if (held.store === 'd1')
      await env.DB.prepare('UPDATE held_envelopes SET attempts = ?, items = ?, leased_until = NULL WHERE key = ?')
        .bind(attempts, left ? left.join(',') : null, held.key)
        .run()
    else await env.FILES.put(held.key, body, { customMetadata: meta(held.endpoint, attempts, left) })
    return 'pending'
  }
  await env.FILES.put(held.key.replace(/^pending\//, 'failed/'), body, {
    customMetadata: meta(held.endpoint, attempts, left),
  })
  const counted = env.DB.prepare(
    'INSERT INTO project_days (project_id, day, failed) VALUES (?, ?, 1) ON CONFLICT DO UPDATE SET failed = failed + 1',
  ).bind(held.projectId, new Date(now).toISOString().slice(0, 10))
  if (held.store === 'd1')
    // The row and the count go together, so a run that stops between them never counts it twice
    await env.DB.batch([env.DB.prepare('DELETE FROM held_envelopes WHERE key = ?').bind(held.key), counted])
  else {
    await env.FILES.delete(held.key)
    await counted.run()
  }
  return 'failed'
}

/**
 * The minute cron: up to 25 held envelopes older than two minutes, D1's first, then R2's (those over D1's size, and
 * any held there by a worker from before 0038), until the deadline, each tried again. A try is counted, and the
 * envelope leased for 90 seconds, before it starts; one with every try used moves to failed/ untried
 */
export async function retryPending(
  env: RetryEnv,
  now: number,
  deadline: number,
  pass: Pass = async (held, body, todo) => (await import('../api/ingest')).retryEnvelope(env, held, body, todo),
): Promise<{ retried: number; failed: number }> {
  const counts = { retried: 0, failed: 0 }
  // Not reached before the deadline: no try counted, it waits for the next minute
  const open = () => Date.now() < deadline && counts.retried < BATCH
  const tryOnce = async (held: Held, body: Uint8Array, attempts: number, todo: Todo | undefined) => {
    let left: Todo | 'all'
    try {
      left = await pass(held, body, todo)
    } catch (error) {
      console.error('retrying an envelope failed', held.key, error)
      left = todo ?? 'all'
    }
    counts.retried++
    if ((await settle(env, held, body, attempts, left, now)) === 'failed') counts.failed++
  }

  // D1: the oldest first, past their first two minutes and any lease. The table holds only envelopes in flight or
  // failing, so a scan without an index reads few rows
  const rows = await env.DB.prepare(
    `SELECT key, project_id, received, endpoint, attempts, items FROM held_envelopes
     WHERE received <= ? AND (leased_until IS NULL OR leased_until <= ?) ORDER BY received LIMIT ?`,
  )
    .bind(now - MIN_AGE, now, BATCH)
    .all<{
      key: string
      project_id: number
      received: number
      endpoint: string
      attempts: number
      items: string | null
    }>()
  for (const row of rows.results) {
    if (!open()) return counts
    const held: Held = {
      key: row.key,
      projectId: row.project_id,
      received: row.received,
      endpoint: row.endpoint === 'store' ? 'store' : 'envelope',
      store: 'd1',
    }
    const todo = row.items ? row.items.split(',') : undefined
    if (row.attempts >= MAX_ATTEMPTS) {
      // Its last try started and never settled, as when it stopped its worker: no more tries
      const found = await env.DB.prepare('SELECT body FROM held_envelopes WHERE key = ?')
        .bind(held.key)
        .first<{ body: string }>()
      if (found && (await settle(env, held, encoder.encode(found.body), row.attempts, todo ?? 'all', now)) === 'failed')
        counts.failed++
      continue
    }
    // Counted and leased in one write, only while no other run holds it, which answers the body
    const claimed = await env.DB.prepare(
      `UPDATE held_envelopes SET attempts = attempts + 1, leased_until = ?
       WHERE key = ? AND (leased_until IS NULL OR leased_until <= ?) RETURNING attempts, items, body`,
    )
      .bind(now + LEASE, held.key, now)
      .first<{ attempts: number; items: string | null; body: string }>()
    if (!claimed) continue
    await tryOnce(
      held,
      encoder.encode(claimed.body),
      claimed.attempts,
      claimed.items ? claimed.items.split(',') : undefined,
    )
  }

  // R2, paged on, so envelopes still in flight (younger than two minutes) never hide older ones listed after them
  let cursor: string | undefined
  do {
    const listed = await env.FILES.list({ prefix: 'pending/', limit: LIST_PAGE, cursor })
    cursor = listed.truncated ? listed.cursor : undefined
    for (const { key } of listed.objects) {
      if (!open()) return counts
      const parsed = parseKey(key)
      if (!parsed || parsed.received > now - MIN_AGE) continue
      const object = await env.FILES.get(key)
      if (!object) continue
      const m = object.customMetadata ?? {}
      if (Number(m.leased_until) > now) continue
      const held: Held = { ...parsed, endpoint: m.endpoint === 'store' ? 'store' : 'envelope', store: 'r2' }
      const todo = m.items ? m.items.split(',') : undefined
      const body = new Uint8Array(await object.arrayBuffer())
      const tried = Number(m.attempts) || 0
      if (tried >= MAX_ATTEMPTS) {
        if ((await settle(env, held, body, tried, todo ?? 'all', now)) === 'failed') counts.failed++
        continue
      }
      const attempts = tried + 1
      await env.FILES.put(key, body, { customMetadata: meta(held.endpoint, attempts, todo, now + LEASE) })
      await tryOnce(held, body, attempts, todo)
    }
  } while (cursor && Date.now() < deadline)
  return counts
}
