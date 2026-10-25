// What never gets stored: values under keys that name a secret, and emails, card numbers and bearer tokens in text.

const SECRET_KEY = /pass(word|wd)?|secret|token|auth|api[-_]?key|cookie|session|credential|private[-_]?key|bearer/i
// A domain ends in letters: `app@1.2.0`, Sentry's way of naming a release, isn't an email
const EMAIL = /[\w.+-]+@(?:[\w-]+\.)+[A-Za-z]{2,}\b/g
const CARD = /\b(?:\d[ -]?){13,19}\b/g
const BEARER = /\b(Bearer|Basic)\s+[\w\-._~+/]+=*/gi

export const FILTERED = '[Filtered]'

export function scrubText(text: string): string {
  return text.replace(BEARER, `$1 ${FILTERED}`).replace(EMAIL, '[email]').replace(CARD, FILTERED)
}

/** A copy of a JSON value with secrets taken out; deep values past `depth` are dropped */
export function scrub(value: unknown, depth = 8): unknown {
  if (typeof value === 'string') return scrubText(value)
  if (depth <= 0 || value === null || typeof value !== 'object') return typeof value === 'object' ? null : value
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth - 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) out[key] = SECRET_KEY.test(key) ? FILTERED : scrub(item, depth - 1)
  return out
}
