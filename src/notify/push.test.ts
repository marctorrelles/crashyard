import { afterEach, describe, expect, it, vi } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { pushDevices, savePushDevice, vapidKeys } from '../data/push'
import type { Notice } from './notice'
import { encrypt, pushPayload, sendPush, unb64url, vapidAuth } from './push'

// RFC 8291, Appendix A
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3j' +
    'l7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

const notice = (over: Partial<Notice> = {}): Notice => ({
  kind: 'new',
  project: { id: 1, slug: 'pocketband', name: 'pocketband' },
  issue: { id: 7, title: 'TypeError: x is undefined', culprit: 'app.js', level: 'error', count: 1 },
  event: { level: 'error', environment: 'production', release: '1.0' },
  url: 'https://crashyard.example.com/issues/7',
  ...over,
})

afterEach(() => vi.unstubAllGlobals())

describe('push', () => {
  it('encrypts as RFC 8291’s example does', async () => {
    const body = await encrypt(new TextEncoder().encode(RFC.plaintext), RFC.uaPublic, RFC.auth, unb64url(RFC.salt), {
      publicKey: RFC.asPublic,
      privateKey: RFC.asPrivate,
    })
    expect(body).toEqual(unb64url(RFC.body))
  })

  it('signs a VAPID token the public key verifies, for the push service’s origin', async () => {
    const keys = await vapidKeys(sqliteD1())
    const header = await vapidAuth('https://web.push.apple.com/abc', keys, 'https://crashyard.example.com', 1e12)
    const [, jwt, k] = header.match(/^vapid t=(\S+), k=(\S+)$/)!
    expect(k).toBe(keys.publicKey)
    const [head, claims, signature] = jwt.split('.')
    expect(JSON.parse(new TextDecoder().decode(unb64url(claims)))).toEqual({
      aud: 'https://web.push.apple.com',
      exp: 1e9 + 12 * 3600,
      sub: 'https://crashyard.example.com',
    })
    const key = await crypto.subtle.importKey('raw', unb64url(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'verify',
    ])
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      unb64url(signature),
      new TextEncoder().encode(`${head}.${claims}`),
    )
    expect(ok).toBe(true)
  })

  it('keeps one key pair, made once', async () => {
    const db = sqliteD1()
    expect((await vapidKeys(db)).publicKey).toBe((await vapidKeys(db)).publicKey)
  })

  it('gives an issue its actions and a tag, a weekly summary silence', () => {
    expect(pushPayload(notice())).toMatchObject({
      tag: 'issue:7',
      actions: [{ action: 'resolve', url: 'https://crashyard.example.com/issues/7?do=resolve' }, { action: 'ignore' }],
      silent: false,
    })
    expect(pushPayload(notice({ kind: 'monitor_down' }))).toMatchObject({ tag: 'monitor:7', actions: [] })
    expect(pushPayload(notice({ kind: 'monitor_up' })).tag).toBe('monitor:7')
    expect(pushPayload(notice({ kind: 'weekly' })).silent).toBe(true)
  })

  it('sends to each device, drops one the browser dropped, and fails only when none took it', async () => {
    const db = sqliteD1()
    const device = (n: number) => ({ endpoint: `https://push.example.com/${n}`, p256dh: RFC.uaPublic, auth: RFC.auth })
    await savePushDevice(db, 'ada@example.com', 'Mac, Chrome', device(1), 1)
    await savePushDevice(db, 'ada@example.com', 'iPhone, Safari', device(2), 2)
    const sent: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        sent.push(url)
        expect(new Headers(init.headers).get('content-encoding')).toBe('aes128gcm')
        return new Response(null, { status: url.endsWith('/2') ? 410 : 201 })
      }),
    )
    await sendPush(db, 'ada@example.com', notice(), 5)
    expect(sent.sort()).toEqual(['https://push.example.com/1', 'https://push.example.com/2'])
    const left = await pushDevices(db, 'ada@example.com')
    expect(left.map((d) => [d.endpoint, d.last_sent_at])).toEqual([['https://push.example.com/1', 5]])

    vi.stubGlobal('fetch', async () => new Response(null, { status: 500 }))
    await expect(sendPush(db, 'ada@example.com', notice(), 6)).rejects.toThrow('HTTP 500')
    await expect(sendPush(db, 'bob@example.com', notice(), 6)).rejects.toThrow('No device has push turned on')
  })

  it('makes the person’s channel with their first device, once', async () => {
    const db = sqliteD1()
    db.sqlite.exec("INSERT INTO users (email, name, role, created_at) VALUES ('ada@example.com', 'Ada', 'owner', 0)")
    const d = { endpoint: 'https://push.example.com/1', p256dh: RFC.uaPublic, auth: RFC.auth }
    await savePushDevice(db, 'ada@example.com', 'Mac', d, 1)
    await savePushDevice(db, 'ada@example.com', 'Mac', { ...d, endpoint: 'https://push.example.com/2' }, 2)
    const channels = db.sqlite.prepare("SELECT name, config FROM channels WHERE kind = 'push'").all()
    expect(channels).toEqual([{ name: 'Ada’s devices', config: '{"email":"ada@example.com"}' }])
    db.sqlite.exec("DELETE FROM users WHERE email = 'ada@example.com'")
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM channels').get()).toEqual({ n: 0 })
    expect(await pushDevices(db, 'ada@example.com')).toEqual([])
  })
})
