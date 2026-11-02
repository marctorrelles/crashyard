// Product analytics through the Sentry SDK the app already has: a log whose attributes carry `crashyard.action` is an
// action (signed up, exported a song), not a log. Its body is the action's name, its own attributes its properties,
// and the scope's user is kept as a hash, as events' are, so actions and errors meet on the same user.
//   Sentry.logger.info('song exported', { format: 'wav', 'crashyard.action': true })
import { hashUser } from '../search/user'
import { timestampOf } from './event'
import { scrub } from './scrub'

export const ACTION_MARK = 'crashyard.action'
const MAX_NAME = 200
const MAX_PROPERTIES = 32

export type Action = {
  timestamp: number // ms
  name: string
  userHash?: string
  release?: string
  environment?: string
  traceId?: string
  properties: Record<string, string | number | boolean>
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
// An attribute is `{ value, type }` on the wire
const raw = (v: unknown) => ('value' in obj(v) ? obj(v).value : v)

/** Whether a log item is an action: its `crashyard.action` attribute is true (or "true", or 1) */
export const isAction = (item: unknown) => {
  const v = raw(obj(obj(item).attributes)[ACTION_MARK])
  return v === true || v === 'true' || v === 1
}

export function normalizeActions(payload: unknown, received: number): Action[] {
  const items = obj(payload).items
  if (!Array.isArray(items)) return []
  return items
    .slice(0, 1000)
    .filter(isAction)
    .flatMap((it) => {
      const item = obj(it)
      const name = String(item.body ?? '')
        .trim()
        .slice(0, MAX_NAME)
      if (!name) return []
      const attributes = obj(item.attributes)
      const str = (k: string) => {
        const v = raw(attributes[k])
        return typeof v === 'string' && v ? v : undefined
      }
      const properties: Action['properties'] = {}
      for (const [key, value] of Object.entries(attributes)) {
        if (key === ACTION_MARK || key.startsWith('sentry.') || key.startsWith('user.')) continue
        if (Object.keys(properties).length >= MAX_PROPERTIES) break
        const v = raw(value)
        if (typeof v === 'string') properties[key] = v.slice(0, 200)
        else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') properties[key] = v
      }
      // As events pick theirs: the id, else the email, else the username
      const user = str('user.id') ?? str('user.email') ?? str('user.username')
      return [
        {
          timestamp: timestampOf(item.timestamp) ?? received,
          name,
          userHash: user ? hashUser(user) : undefined,
          release: str('sentry.release'),
          environment: str('sentry.environment'),
          traceId:
            typeof item.trace_id === 'string' && /^[0-9a-f]{32}$/.test(item.trace_id) ? item.trace_id : undefined,
          properties: scrub(properties) as Action['properties'],
        },
      ]
    })
}

/** Writes actions, a row each (three rows written with its indexes), in one batch */
export async function storeActions(db: D1Database, projectId: number, actions: Action[]) {
  if (!actions.length) return
  await db.batch(
    actions.map((a) =>
      db
        .prepare(
          `INSERT INTO actions (project_id, timestamp, name, user_hash, release, environment, trace_id, properties)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          projectId,
          a.timestamp,
          a.name,
          a.userHash ?? null,
          a.release ?? null,
          a.environment ?? null,
          a.traceId ?? null,
          JSON.stringify(a.properties),
        ),
    ),
  )
}
