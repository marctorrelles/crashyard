// Push notifications: each person's devices (0033), their push channel, and the deployment's VAPID keys.
import { getSetting } from './settings'

export type PushDevice = {
  id: number
  email: string
  endpoint: string
  p256dh: string
  auth: string
  name: string
  created_at: number
  last_sent_at: number | null
}
/** The deployment's VAPID key pair: the public key raw (65 bytes) as base64url, the private one as a JWK */
export type VapidKeys = { publicKey: string; privateKey: JsonWebKey }

const VAPID_KEY = 'push.vapid'
export const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

/** Made on first use and kept in `settings`: no secret to set. Two first calls at once agree on the one written */
export async function vapidKeys(db: D1Database): Promise<VapidKeys> {
  const kept = await getSetting<VapidKeys | null>(db, VAPID_KEY, null)
  if (kept) return kept
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const keys: VapidKeys = {
    publicKey: b64url((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
    privateKey: (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey,
  }
  await db
    .prepare('INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, NULL, ?) ON CONFLICT DO NOTHING')
    .bind(VAPID_KEY, JSON.stringify(keys), Date.now())
    .run()
  return (await getSetting<VapidKeys | null>(db, VAPID_KEY, null)) ?? keys
}

export const pushDevices = async (db: D1Database, email: string) =>
  (await db.prepare('SELECT * FROM push_devices WHERE email = ? ORDER BY created_at').bind(email).all<PushDevice>())
    .results

/** By endpoint, so the same browser saved again, or by someone else signed in on it, is one device, theirs. Their
 *  push channel is made with the first */
export async function savePushDevice(
  db: D1Database,
  email: string,
  name: string,
  d: { endpoint: string; p256dh: string; auth: string },
  now: number,
) {
  await db.batch([
    db
      .prepare(
        `INSERT INTO push_devices (email, endpoint, p256dh, auth, name, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET email = excluded.email, p256dh = excluded.p256dh, auth = excluded.auth,
           name = excluded.name`,
      )
      .bind(email, d.endpoint, d.p256dh, d.auth, name, now),
    db
      .prepare(
        `INSERT INTO channels (kind, name, config, created_at)
         SELECT 'push', COALESCE((SELECT name FROM users WHERE email = ?1), ?1) || '’s devices', json_object('email', ?1), ?2
         WHERE NOT EXISTS (SELECT 1 FROM channels WHERE kind = 'push' AND json_extract(config, '$.email') = ?1)`,
      )
      .bind(email, now),
  ])
}

/** One's own only: by id for the list, by endpoint for "Turn off on this device" */
export const deletePushDevice = (db: D1Database, email: string, by: { id?: number; endpoint?: string }) =>
  db
    .prepare('DELETE FROM push_devices WHERE email = ? AND (id = ? OR endpoint = ?)')
    .bind(email, by.id ?? null, by.endpoint ?? null)
    .run()

/** The person's push channel and how many routes send to it, for Preferences */
export const pushChannel = (db: D1Database, email: string) =>
  db
    .prepare(
      `SELECT c.id, c.name, (SELECT count(*) FROM routes r, json_each(r.channel_ids) j WHERE j.value = c.id) AS routes
       FROM channels c WHERE c.kind = 'push' AND json_extract(c.config, '$.email') = ?`,
    )
    .bind(email)
    .first<{ id: number; name: string; routes: number }>()
