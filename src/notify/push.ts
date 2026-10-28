// Web Push to a person's devices: VAPID (RFC 8292) to say who sends, the payload encrypted for each browser
// (RFC 8291, aes128gcm), both with the Worker's WebCrypto.
import { b64url, deletePushDevice, pushDevices, vapidKeys, type VapidKeys, type PushDevice } from '../data/push'
import { ISSUE_KINDS, type Notice, noticeLine } from './notice'

const enc = new TextEncoder()
type Bytes = Uint8Array<ArrayBuffer>
export const unb64url = (text: string): Bytes =>
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const concat = (...parts: Bytes[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) out.set(p, (at += p.length) - p.length)
  return out
}
const hkdf = async (salt: Bytes, ikm: Bytes, info: Bytes, bytes: number) =>
  new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info },
      await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']),
      bytes * 8,
    ),
  )

/** An uncompressed P-256 point (65 bytes, 0x04 x y) as a JWK, with `d` for a private key */
const pointJwk = (raw: Bytes, d?: string): JsonWebKey => ({
  kty: 'EC',
  crv: 'P-256',
  x: b64url(raw.slice(1, 33)),
  y: b64url(raw.slice(33, 65)),
  ...(d ? { d } : {}),
})

/**
 * The body for one browser: aes128gcm with one record, its header the salt, the record size, our public key. `salt`
 * and `server` (our ECDH pair, the private key as base64url) are only passed by the test, for RFC 8291's example
 */
export async function encrypt(
  payload: Bytes,
  p256dh: string,
  auth: string,
  salt = crypto.getRandomValues(new Uint8Array(16)),
  server?: { publicKey: string; privateKey: string },
) {
  const uaPublic = unb64url(p256dh)
  const ecdh = { name: 'ECDH', namedCurve: 'P-256' }
  const pair = server
    ? {
        privateKey: await crypto.subtle.importKey(
          'jwk',
          pointJwk(unb64url(server.publicKey), server.privateKey),
          ecdh,
          false,
          ['deriveBits'],
        ),
        publicKey: unb64url(server.publicKey),
      }
    : await crypto.subtle.generateKey(ecdh, true, ['deriveBits']).then(async (p) => {
        const keys = p as CryptoKeyPair
        return {
          privateKey: keys.privateKey,
          publicKey: new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer),
        }
      })
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: await crypto.subtle.importKey('raw', uaPublic, ecdh, false, []) },
      pair.privateKey,
      256,
    ),
  )
  const ikm = await hkdf(unb64url(auth), secret, concat(enc.encode('WebPush: info\0'), uaPublic, pair.publicKey), 32)
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  // 0x02: the last (and only) record's padding delimiter
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, new Uint8Array([2])))
  const header = new Uint8Array(21)
  new DataView(header.buffer).setUint32(16, 4096)
  header.set(salt)
  header[20] = 65
  return concat(header, pair.publicKey, new Uint8Array(sealed))
}

/** The Authorization header for a push service: an ES256 JWT for its origin, 12 hours, from `sub` */
export async function vapidAuth(endpoint: string, keys: VapidKeys, sub: string, now: number) {
  const part = (o: object) => b64url(enc.encode(JSON.stringify(o)))
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub,
  })}`
  const key = await crypto.subtle.importKey('jwk', keys.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ])
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned))
  return `vapid t=${unsigned}.${b64url(signature)}, k=${keys.publicKey}`
}

/** What the service worker (public/sw.js) shows: a newer notice of the same issue, monitor or alert replaces the
 *  older on the device; an issue's Resolve and Ignore are its confirm-on-the-page links, as email's */
export function pushPayload(notice: Notice) {
  const issue = ISSUE_KINDS.has(notice.kind)
  return {
    title: notice.issue.title.slice(0, 120),
    body: noticeLine(notice).slice(0, 300),
    url: notice.url,
    // monitor_down and monitor_up share `monitor:`, the metric kinds `metric:`
    tag: `${issue ? 'issue' : notice.kind.split('_')[0]}:${notice.issue.id}`,
    actions: issue
      ? [
          { action: 'resolve', title: 'Resolve', url: `${notice.url}?do=resolve` },
          { action: 'ignore', title: 'Ignore', url: `${notice.url}?do=ignore` },
        ]
      : [],
    silent: notice.kind === 'weekly',
  }
}

const urgency = (notice: Notice) =>
  notice.kind === 'monitor_down' || notice.kind === 'metric_critical' || notice.issue.level === 'fatal'
    ? 'high'
    : notice.kind === 'weekly'
      ? 'low'
      : 'normal'

const PUSH_TIMEOUT = 10_000

/** One device; a 404 or 410 means the browser dropped it, so it's deleted. Says whether it took it */
async function sendTo(db: D1Database, device: PushDevice, body: Bytes, auth: string, urgent: string) {
  const response = await fetch(device.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Urgency: urgent,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: auth,
    },
    body,
    signal: AbortSignal.timeout(PUSH_TIMEOUT),
  })
  await response.body?.cancel()
  if (response.status === 404 || response.status === 410) {
    await deletePushDevice(db, device.email, { id: device.id })
    throw new Error(`${device.name} no longer takes notifications, so it was removed`)
  }
  if (!response.ok) throw new Error(`${device.name}: the push service answered HTTP ${response.status}`)
}

/**
 * A notice to every device of a push channel's person, at once. Throws, for Health, only when none took it; `only`,
 * one device's endpoint, for its test
 */
export async function sendPush(db: D1Database, email: string, notice: Notice, now: number, only?: string) {
  const devices = (await pushDevices(db, email)).filter((d) => !only || d.endpoint === only)
  if (!devices.length) throw new Error('No device has push turned on. Turn it on in Settings, Preferences.')
  const keys = await vapidKeys(db)
  const payload = enc.encode(JSON.stringify(pushPayload(notice)))
  const results = await Promise.allSettled(
    devices.map(async (d) => {
      const auth = await vapidAuth(d.endpoint, keys, new URL(notice.url).origin, now)
      await sendTo(db, d, await encrypt(payload, d.p256dh, d.auth), auth, urgency(notice))
      return d.id
    }),
  )
  const sent = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  if (sent.length)
    await db
      .prepare('UPDATE push_devices SET last_sent_at = ? WHERE id IN (SELECT value FROM json_each(?))')
      .bind(now, JSON.stringify(sent))
      .run()
  else throw (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason
}
