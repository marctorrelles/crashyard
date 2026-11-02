// Product analytics through the Sentry SDK the app already has: a log whose attributes carry `crashyard.action` is an
// action (signed up, exported a song), not a log. Its body is the action's name, its own attributes its properties,
// and the scope's user is kept as a hash, as events' are, so actions and errors meet on the same user.
//   Sentry.logger.info('song exported', { format: 'wav', 'crashyard.action': true })
import { hashUser } from '../search/user'
import { timestampOf } from './event'
import { scrub, scrubText } from './scrub'

export const ACTION_MARK = 'crashyard.action'
const MAX_NAME = 200
const MAX_PROPERTIES = 32
// The SDK's own attributes, and those kept as columns: not properties
const CONTEXT = /^(sentry|user|os|device|browser|server)\./

export type Action = {
  timestamp: number // ms
  name: string
  userHash?: string
  release?: string
  environment?: string
  traceId?: string
  platform?: string
  os?: string
  device?: string
  browser?: string
  country?: string
  properties: Record<string, string | number | boolean>
}

// The platform an SDK is for, from `sentry.sdk.name` (sentry.javascript.react, sentry.cocoa, sentry.java.android…)
const PLATFORMS: [RegExp, string][] = [
  [/react-?native/, 'React Native'],
  [/flutter|dart/, 'Flutter'],
  [/android/, 'Android'],
  [/cocoa|swift/, 'Apple'],
  [/javascript\.(node|bun|deno|cloudflare|aws|google|nextjs\.server)/, 'Server'],
  [/javascript/, 'Web'],
  [/unity/, 'Unity'],
]
export const platformOf = (sdk?: string) => {
  if (!sdk) return undefined
  const found = PLATFORMS.find(([re]) => re.test(sdk))
  return found ? found[1] : sdk.replace(/^sentry\./, '')
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

export function normalizeActions(payload: unknown, received: number, country?: string): Action[] {
  const items = obj(payload).items
  if (!Array.isArray(items)) return []
  return items
    .slice(0, 1000)
    .filter(isAction)
    .flatMap((it) => {
      const item = obj(it)
      // Scrubbed as a log's body is: a name built with an email in it keeps none
      const name = scrubText(String(item.body ?? '').trim()).slice(0, MAX_NAME)
      if (!name) return []
      const attributes = obj(item.attributes)
      // A string, or a number as one (`setUser({ id: 42 })` sends an integer), as events read theirs
      const str = (k: string) => {
        const v = raw(attributes[k])
        if (typeof v === 'number' && Number.isFinite(v)) return String(v)
        return typeof v === 'string' && v ? v : undefined
      }
      const properties: Action['properties'] = {}
      for (const [key, value] of Object.entries(attributes)) {
        if (key === ACTION_MARK || CONTEXT.test(key)) continue
        if (key.length > 100) continue
        if (Object.keys(properties).length >= MAX_PROPERTIES) break
        const v = raw(value)
        if (typeof v === 'string') properties[key] = v.slice(0, 200)
        else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') properties[key] = v
      }
      // As events pick theirs: the id, else the email, else the username, which logs carry as `user.name`
      const user = str('user.id') ?? str('user.email') ?? str('user.name')
      return [
        {
          timestamp: timestampOf(item.timestamp) ?? received,
          name,
          userHash: user ? hashUser(user) : undefined,
          release: str('sentry.release'),
          environment: str('sentry.environment'),
          platform: platformOf(str('sentry.sdk.name')),
          os: str('os.name'),
          device: str('device.model') ?? str('device.family'),
          browser: str('browser.name'),
          country: country && /^[A-Z]{2}$/.test(country) ? country : undefined,
          traceId:
            typeof item.trace_id === 'string' && /^[0-9a-f]{32}$/.test(item.trace_id) ? item.trace_id : undefined,
          properties: scrub(properties) as Action['properties'],
        },
      ]
    })
}

/**
 * The statement that writes actions: one `INSERT … SELECT` over them as JSON, so a batch of any size is one query.
 * Three rows written an action with the indexes. `src/api/ingest.ts` runs it in the same batch as the item's logs
 */
export function actionsStatement(db: D1Database, projectId: number, actions: Action[]) {
  return db
    .prepare(
      `INSERT INTO actions (project_id, timestamp, name, user_hash, release, environment, trace_id, platform, os,
         device, browser, country, properties)
       SELECT ?, json_extract(value, '$.timestamp'), json_extract(value, '$.name'), json_extract(value, '$.userHash'),
         json_extract(value, '$.release'), json_extract(value, '$.environment'), json_extract(value, '$.traceId'),
         json_extract(value, '$.platform'), json_extract(value, '$.os'), json_extract(value, '$.device'),
         json_extract(value, '$.browser'), json_extract(value, '$.country'), json(json_extract(value, '$.properties'))
       FROM json_each(?)`,
    )
    .bind(projectId, JSON.stringify(actions))
}
