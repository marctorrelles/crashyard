import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import * as people from '../data/people'
import { handleAuth } from './passkeys'
import { whoIs } from './session'

const NOW = 1_800_000_000_000
const DAY = 864e5
const URL_ = 'https://crashes.example.com'
const env = (db: D1Database, vars: Record<string, string> = {}) =>
  ({ DB: db, AUTH: 'crashyard', PUBLIC_URL: URL_, SETUP_CODE: '', ...vars }) as unknown as Env
const owner = (db: D1Database, email = 'ada@example.com', role: people.Role = 'owner') =>
  people.createUser(db, { email, name: 'Ada', role, createdBy: null }, NOW)

describe('whoIs', () => {
  const request = (cookie?: string) => new Request(`${URL_}/`, { headers: cookie ? { Cookie: cookie } : {} })

  it('lets a dev server in as dev@localhost unless AUTH is crashyard', async () => {
    const db = sqliteD1()
    expect(await whoIs(request(), env(db, { AUTH: '' }), true, NOW)).toEqual({
      email: 'dev@localhost',
      role: 'owner',
    })
    expect(await whoIs(request(), env(db), true, NOW)).toBeNull()
  })

  it('knows a session, and not one that ended, expired or whose person was removed', async () => {
    const db = sqliteD1()
    const user = await owner(db)
    const { token } = await people.startSession(db, user.id, 'Safari', NOW)
    const who = await whoIs(request(`a=b; crashyard_session=${token}`), env(db), false, NOW + 1000)
    expect(who).toMatchObject({ email: 'ada@example.com', role: 'owner', userId: user.id, cookie: undefined })
    expect(await whoIs(request('crashyard_session=nope'), env(db), false, NOW)).toBeNull()
    expect(
      await whoIs(request(`crashyard_session=${token}`), env(db), false, NOW + people.SESSION_DAYS * DAY),
    ).toBeNull()
    await people.createUser(db, { email: 'bo@example.com', name: 'Bo', role: 'owner', createdBy: null }, NOW)
    await people.removeUser(db, user.id)
    expect(await whoIs(request(`crashyard_session=${token}`), env(db), false, NOW + 1000)).toBeNull()
  })

  it('renews a session under 60 days left, at most once a day, as an HttpOnly, Secure, Lax cookie', async () => {
    const db = sqliteD1()
    const user = await owner(db)
    const { token } = await people.startSession(db, user.id, null, NOW)
    const later = NOW + 31 * DAY
    const who = await whoIs(request(`crashyard_session=${token}`), env(db), false, later)
    expect(who?.cookie).toMatch(/^crashyard_session=.+; Path=\/; HttpOnly; SameSite=Lax; Expires=.+; Secure$/)
    const again = await whoIs(request(`crashyard_session=${token}`), env(db), false, later + 1000)
    expect(again?.cookie).toBeUndefined()
  })
})

describe('/auth', () => {
  const post = (path: string, body: unknown, db: D1Database, vars?: Record<string, string>, origin = URL_) =>
    handleAuth(path, {
      request: new Request(`${URL_}/auth/${path}`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env: env(db, vars),
      dev: false,
      who: null,
      now: NOW,
    })
  const error = async (r: Response | null) => ((await r!.json()) as { error?: string }).error

  it('answers only the dashboard’s own pages', async () => {
    const r = await post('signin/options', {}, sqliteD1(), {}, 'https://elsewhere.example.com')
    expect(r!.status).toBe(403)
  })

  it('sets up only with the setup code, and only while there’s no one', async () => {
    const db = sqliteD1()
    const person = { name: 'Ada', email: 'Ada@Example.com' }
    expect(await error(await post('setup/options', person, db))).toMatch(/SETUP_CODE/)
    const vars = { SETUP_CODE: 'ABCDE-FGHJK-MNPQR' }
    expect(await error(await post('setup/options', { ...person, code: 'ABCDE' }, db, vars))).toMatch(/isn’t right/)
    const ok = await post('setup/options', { ...person, code: 'abcde fghjk mnpqr' }, db, vars)
    const { options } = (await ok!.json()) as { options: { rp: { id: string }; user: { name: string } } }
    expect(options.rp.id).toBe('crashes.example.com')
    expect(options.user.name).toBe('ada@example.com')
    await owner(db)
    expect(await error(await post('setup/options', { ...person, code: vars.SETUP_CODE }, db, vars))).toMatch(
      /already set up/,
    )
  })

  it('takes a challenge once, and not after five minutes', async () => {
    const db = sqliteD1()
    const id = await people.saveChallenge(db, 'c', 'signin', {}, NOW)
    expect(await people.takeChallenge(db, id, 'setup', NOW)).toBeNull()
    expect(await people.takeChallenge(db, id, 'signin', NOW)).toMatchObject({ challenge: 'c' })
    expect(await people.takeChallenge(db, id, 'signin', NOW)).toBeNull()
    const old = await people.saveChallenge(db, 'c', 'signin', {}, NOW)
    expect(await people.takeChallenge(db, old, 'signin', NOW + 5 * 60_000)).toBeNull()
  })

  it('refuses a used or expired invite', async () => {
    const db = sqliteD1()
    await owner(db)
    const token = await people.createInvite(db, 'member', null, 'ada@example.com', NOW)
    const ok = await post('invite/options', { token, name: 'Bo', email: 'bo@example.com' }, db)
    expect(ok!.status).toBe(200)
    const { hash } = (await people.inviteOf(db, token, NOW))!
    expect((await people.useInvite(db, hash, null, NOW).run()).meta.changes).toBe(1)
    expect((await people.useInvite(db, hash, null, NOW).run()).meta.changes).toBe(0)
    expect(await error(await post('invite/options', { token, name: 'Bo', email: 'bo@example.com' }, db))).toMatch(
      /expired or was already used/,
    )
    const late = await people.createInvite(db, 'member', null, 'ada@example.com', NOW - people.INVITE_DAYS * DAY)
    expect((await people.inviteOf(db, late, NOW))?.usable).toBe(false)
  })

  it('signs in once with each recovery code', async () => {
    const db = sqliteD1()
    const user = await owner(db)
    const [code] = await people.newRecoveryCodes(db, user.id)
    const r = await post('recover', { email: 'ADA@example.com', code: code.toLowerCase().replace('-', ' ') }, db)
    expect(r!.headers.get('Set-Cookie')).toMatch(/^crashyard_session=/)
    expect(await r!.json()).toMatchObject({ ok: true, left: people.RECOVERY_CODES - 1 })
    expect(await error(await post('recover', { email: 'ada@example.com', code }, db))).toMatch(/don’t match/)
  })

  it('signs out: the session ends and the cookie is cleared', async () => {
    const db = sqliteD1()
    const user = await owner(db)
    const { token } = await people.startSession(db, user.id, null, NOW)
    const r = await handleAuth('signout', {
      request: new Request(`${URL_}/auth/signout`, {
        method: 'POST',
        headers: { Origin: URL_, Cookie: `crashyard_session=${token}` },
      }),
      env: env(db),
      dev: false,
      who: null,
      now: NOW,
    })
    expect(r!.status).toBe(303)
    expect(r!.headers.get('Set-Cookie')).toMatch(/Max-Age=0/)
    expect(await people.sessionUser(db, token, NOW)).toBeNull()
  })
})

describe('people', () => {
  it('always keeps an owner', async () => {
    const db = sqliteD1()
    const ada = await owner(db)
    await expect(people.changeRole(db, ada.id, 'admin')).rejects.toThrow(/needs an owner/)
    await expect(people.removeUser(db, ada.id)).rejects.toThrow(/needs an owner/)
    const bo = await owner(db, 'bo@example.com')
    await people.changeRole(db, ada.id, 'viewer')
    await expect(people.removeUser(db, bo.id)).rejects.toThrow(/needs an owner/)
  })

  it('keeps a way to sign in when a passkey goes', async () => {
    const db = sqliteD1()
    const ada = await owner(db)
    const key = (id: string) => ({ id, userId: ada.id, publicKey: new Uint8Array([1]), counter: 0, name: id })
    await people.addPasskey(db, key('a'), NOW).run()
    await expect(people.removePasskey(db, ada.id, 'a')).rejects.toThrow(/only way to sign in/)
    await people.newRecoveryCodes(db, ada.id)
    await people.removePasskey(db, ada.id, 'a')
    expect(await people.passkeysOf(db, ada.id)).toEqual([])
  })

  it('acts for an agent token’s person until it expires or they’re removed, marking it used once a minute', async () => {
    const db = sqliteD1()
    const ada = await owner(db)
    const bo = await owner(db, 'bo@example.com', 'admin')
    const token = await people.createUserToken(db, bo.id, 'Claude', 'change', NOW + DAY, NOW)
    expect(token).toMatch(/^cyp_/)
    const found = await people.userTokenOf(db, token, NOW)
    expect(found).toMatchObject({ user: { email: 'bo@example.com' }, scope: 'change' })
    expect(people.tokenRole(found!.user.role, found!.scope)).toBe('member')
    await people.userTokenOf(db, token, NOW + 30_000)
    expect((await people.userTokensOf(db, bo.id))[0].last_used_at).toBe(NOW)
    expect(await people.userTokenOf(db, token, NOW + DAY)).toBeNull()
    const other = await people.createUserToken(db, bo.id, 'CI', 'read', null, NOW)
    await people.removeUser(db, bo.id)
    expect(await people.userTokenOf(db, other, NOW)).toBeNull()
    expect(ada.role).toBe('owner')
  })

  it('reads roles in order', () => {
    expect(people.reaches('owner', 'admin')).toBe(true)
    expect(people.reaches('member', 'member')).toBe(true)
    expect(people.reaches('member', 'admin')).toBe(false)
    expect(people.reaches('viewer', 'member')).toBe(false)
  })

  it('names a passkey after the browser that made it', () => {
    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1'
    expect(people.deviceName(iphone)).toBe('iPhone, Safari')
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'
    expect(people.deviceName(mac)).toBe('Mac, Chrome')
    expect(people.deviceName(null)).toBe('Passkey')
  })
})

// Every server function that changes something names the least role it needs, so a new one can't forget
it('gives every changing server function a role', () => {
  const source = readFileSync('src/fns.ts', 'utf8')
  const posts = [
    ...source.matchAll(/export const (\w+) = createServerFn\(\{ method: 'POST' \}\)\n\s*\.middleware\(\[(\w+)\]\)/g),
  ]
  expect(posts.length).toBe(source.match(/createServerFn\(\{ method: 'POST' \}\)/g)?.length)
  const roles = Object.fromEntries(posts.map((m) => [m[1], m[2]]))
  expect(roles).toMatchObject({
    changeIssues: 'member',
    saveChannel: 'admin',
    createInvite: 'owner',
    savePreference: 'signedIn',
  })
})
