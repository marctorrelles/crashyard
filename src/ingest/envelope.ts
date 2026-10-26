// Sentry's envelope format (https://develop.sentry.dev/sdk/data-model/envelopes/): a JSON header line, then items,
// each a JSON header line and a payload, either `length` bytes long or up to the next newline.

export type EnvelopeItem = { header: { type?: string; length?: number; [key: string]: unknown }; payload: Uint8Array }
export type Envelope = { header: { event_id?: string; dsn?: string; [key: string]: unknown }; items: EnvelopeItem[] }

export class EnvelopeError extends Error {}

const NEWLINE = 0x0a
const text = new TextDecoder()

function json(bytes: Uint8Array, what: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text.decode(bytes))
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  } catch {
    // reported below
  }
  throw new EnvelopeError(`the ${what} isn't a JSON object`)
}

export function parseEnvelope(body: Uint8Array): Envelope {
  const lineEnd = (from: number) => {
    const at = body.indexOf(NEWLINE, from)
    return at < 0 ? body.length : at
  }
  let end = lineEnd(0)
  const header = json(body.subarray(0, end), 'envelope header')
  const items: EnvelopeItem[] = []
  let pos = end + 1
  while (pos < body.length) {
    end = lineEnd(pos)
    if (end === pos) {
      pos++ // a blank line between items
      continue
    }
    const itemHeader = json(body.subarray(pos, end), 'item header')
    pos = end + 1
    const length = itemHeader.length
    let payload: Uint8Array
    if (typeof length === 'number') {
      if (!Number.isInteger(length) || length < 0 || pos + length > body.length) {
        throw new EnvelopeError('an item is shorter than its length says')
      }
      payload = body.subarray(pos, pos + length)
      pos += length
      if (body[pos] === NEWLINE) pos++
    } else {
      end = lineEnd(pos)
      payload = body.subarray(pos, end)
      pos = end + 1
    }
    items.push({ header: itemHeader, payload })
  }
  return { header, items }
}

export const payloadJson = (item: EnvelopeItem) => json(item.payload, `${item.header.type ?? 'item'} payload`)

/** An envelope written out, each item with its `length`: what an HTTP check-in or a security report is held as */
export function toEnvelope(header: Envelope['header'], items: EnvelopeItem[]): Uint8Array {
  const encode = (s: string) => new TextEncoder().encode(s)
  const parts: Uint8Array[] = [encode(`${JSON.stringify(header)}\n`)]
  for (const item of items)
    parts.push(
      encode(`${JSON.stringify({ ...item.header, length: item.payload.byteLength })}\n`),
      item.payload,
      encode('\n'),
    )
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}
