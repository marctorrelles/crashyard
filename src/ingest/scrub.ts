// What never gets stored: values under keys that name a secret, and emails, card numbers and bearer tokens in text.
import { getSetting, SCRUB_KEY } from '../data/settings'

const SECRET_KEY = /pass(word|wd)?|secret|token|auth|api[-_]?key|cookie|session|credential|private[-_]?key|bearer/i
// A domain ends in letters: `app@1.2.0`, Sentry's way of naming a release, isn't an email
const EMAIL = /[\w.+-]+@(?:[\w-]+\.)+[A-Za-z]{2,}\b/g
const CARD = /\b(?:\d[ -]?){13,19}\b/g
const BEARER = /\b(Bearer|Basic)\s+[\w\-._~+/]+=*/gi

export const FILTERED = '[Filtered]'

// The deployment's own field names to scrub (Settings, Privacy), on top of SECRET_KEY: a key containing one,
// whatever its case, is filtered, as Sentry's additional sensitive fields
let extra: string[] = []
export const setExtraFields = (names: string[]) => {
  extra = names.map((n) => n.trim().toLowerCase()).filter(Boolean)
}
const secret = (key: string) => {
  if (SECRET_KEY.test(key)) return true
  const k = key.toLowerCase()
  return extra.some((name) => k.includes(name))
}

/**
 * The extra names from settings, read at most once a minute per isolate; ingest calls it before scrubbing. A read
 * that fails keeps the last list loaded (none, the built-ins only, before the first), so it never fails an envelope
 */
let loaded = { at: -Infinity }
export async function loadExtraFields(db: D1Database, now = Date.now()) {
  if (now - loaded.at < 60_000) return
  loaded = { at: now }
  try {
    setExtraFields(await getSetting<string[]>(db, SCRUB_KEY, []))
  } catch (error) {
    console.error('could not read the fields to scrub, keeping the last list', error)
  }
}

export function scrubText(text: string): string {
  return text.replace(BEARER, `$1 ${FILTERED}`).replace(EMAIL, '[email]').replace(CARD, FILTERED)
}

/** A copy of a JSON value with secrets taken out; deep values past `depth` are dropped */
export function scrub(value: unknown, depth = 8): unknown {
  if (typeof value === 'string') return scrubText(value)
  if (depth <= 0 || value === null || typeof value !== 'object') return typeof value === 'object' ? null : value
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth - 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) out[key] = secret(key) ? FILTERED : scrub(item, depth - 1)
  return out
}
