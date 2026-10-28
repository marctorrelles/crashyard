// Forward to Sentry (a project's settings, Sentry): every envelope the project accepts goes on to a Sentry DSN too,
// as it arrived, so a team can run crashyard next to Sentry before leaving it. Sent once, without retries: Sentry is
// the copy, and what it answers never changes crashyard's answer to the SDK.

/** A request crashyard forwarded carries this, so a DSN pointing back at a crashyard forwards no further */
export const FORWARDED = 'x-crashyard-forwarded'

/** A Sentry DSN's envelope endpoint and key, and the DSN tidied; null when it isn't one */
export function sentryTarget(dsn: string) {
  let url: URL
  try {
    url = new URL(dsn.trim())
  } catch {
    return null
  }
  // A self-hosted Sentry may sit under a path: https://key@host/sentry/42
  const path = url.pathname.match(/^(.*?)\/(\d+)\/?$/)
  if (!/^https?:$/.test(url.protocol) || !url.username || url.password || !path) return null
  const base = `${url.protocol}//${url.host}${path[1]}`
  return {
    url: `${base}/api/${path[2]}/envelope/`,
    key: url.username,
    dsn: `${url.protocol}//${url.username}@${url.host}${path[1]}/${path[2]}`,
  }
}

const encoder = new TextEncoder()

/** The envelope with its header's `dsn`, when it names one, swapped for Sentry's, so it matches the key it's sent with */
export function retarget(body: Uint8Array, dsn: string) {
  const end = body.indexOf(10)
  const line = new TextDecoder().decode(end < 0 ? body : body.subarray(0, end))
  let header: unknown
  try {
    header = JSON.parse(line)
  } catch {
    return body
  }
  if (!header || typeof header !== 'object' || !('dsn' in header)) return body
  const head = encoder.encode(JSON.stringify({ ...header, dsn }))
  const rest = end < 0 ? new Uint8Array() : body.subarray(end)
  const out = new Uint8Array(head.byteLength + rest.byteLength)
  out.set(head)
  out.set(rest, head.byteLength)
  return out
}

/** Sends the envelope to the project's Sentry DSN; a failure is logged, never thrown */
export async function forwardToSentry(dsn: string, body: Uint8Array, userAgent: string | null) {
  const target = sentryTarget(dsn)
  if (!target) return
  try {
    const response = await fetch(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-sentry-envelope',
        'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${target.key}`,
        [FORWARDED]: '1',
        // The SDK's, as Sentry reads it for the client; the client's IP isn't passed on, as crashyard keeps none
        ...(userAgent ? { 'user-agent': userAgent } : {}),
      },
      body: retarget(body, target.dsn) as Uint8Array<ArrayBuffer>,
    })
    if (!response.ok) console.warn(`forward: Sentry answered ${response.status} for ${target.url}`)
  } catch (error) {
    console.warn(`forward: couldn't reach ${target.url}`, error)
  }
}
