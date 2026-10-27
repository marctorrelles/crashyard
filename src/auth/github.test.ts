import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import * as people from '../data/people'
import { setSetting } from '../data/settings'
import { GITHUB_KEY, handleGitHub, manifest, startApp } from './github'

const NOW = 1_800_000_000_000
const BASE = 'https://crashes.example.com'
const APP = { appId: 1, slug: 'crashyard-x', clientId: 'Iv1.abc', clientSecret: 's3cret', owner: 'ada' }

// GitHub, as far as signing in asks it: the token, the user, their emails
function gitHub(user: { id: number; login: string; name?: string }, emails: { email: string; verified: boolean }[]) {
  const calls: { url: string; body?: string }[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: init?.body as string | undefined })
    if (url.endsWith('/login/oauth/access_token')) return Response.json({ access_token: 'gho_1' })
    if (url.endsWith('/user')) return Response.json({ name: null, ...user })
    if (url.endsWith('/user/emails')) return Response.json(emails.map((e, i) => ({ ...e, primary: i === 0 })))
    if (url.includes('/app-manifests/'))
      return Response.json({
        id: 9,
        slug: 'crashyard-x',
        client_id: 'Iv1.abc',
        client_secret: 's3cret',
        owner: { login: 'ada' },
      })
    return new Response('not found', { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

async function signInWith(db: D1Database, gh: ReturnType<typeof gitHub>, query = '') {
  const start = await handleGitHub('start', {
    request: new Request(`${BASE}/auth/github/start${query}`),
    db,
    base: BASE,
    who: null,
    now: NOW,
  })
  const authorize = new URL(start!.headers.get('Location')!)
  const state = authorize.searchParams.get('state')!
  const cookie = start!.headers.get('Set-Cookie')!.split(';')[0]
  return handleGitHub('callback', {
    request: new Request(`${BASE}/auth/github/callback?code=c&state=${state}`, { headers: { Cookie: cookie } }),
    db,
    base: BASE,
    who: null,
    now: NOW,
    fetch: gh.fetch,
  })
}

describe('Sign in with GitHub', () => {
  it('builds the app’s manifest from the dashboard’s address', async () => {
    expect(manifest(BASE)).toMatchObject({
      name: 'crashyard crashes.example.com',
      redirect_url: `${BASE}/auth/github/created`,
      callback_urls: [`${BASE}/auth/github/callback`],
      public: false,
      default_permissions: { emails: 'read' },
    })
    expect(manifest('https://a-very-long-subdomain.example.com').name.length).toBeLessThanOrEqual(34)
    const { action } = await startApp(sqliteD1(), BASE, 'acme', 'ada@example.com', NOW)
    expect(action).toMatch(/^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=/)
  })

  it('keeps the app GitHub hands back, only for an owner and its own state', async () => {
    const db = sqliteD1()
    const { action } = await startApp(db, BASE, null, 'ada@example.com', NOW)
    const state = new URL(action).searchParams.get('state')
    const created = (who: { email: string; role: people.Role } | null) =>
      handleGitHub('created', {
        request: new Request(`${BASE}/auth/github/created?code=m&state=${state}`),
        db,
        base: BASE,
        who,
        now: NOW,
        fetch: gitHub({ id: 1, login: 'ada' }, []).fetch,
      })
    expect((await created({ email: 'bo@example.com', role: 'admin' }))!.headers.get('Location')).toBe('/signin')
    expect((await created({ email: 'ada@example.com', role: 'owner' }))!.headers.get('Location')).toMatch(/added/)
    expect((await created({ email: 'ada@example.com', role: 'owner' }))!.headers.get('Location')).toMatch(/stale/)
  })

  it('sends PKCE and signs in someone here by a verified email, then by their account', async () => {
    const db = sqliteD1()
    await setSetting(db, GITHUB_KEY, APP, null, NOW)
    const ada = await people.createUser(
      db,
      { email: 'ada@example.com', name: 'Ada', role: 'owner', createdBy: null },
      NOW,
    )
    const gh = gitHub({ id: 42, login: 'ada' }, [
      { email: 'ada@work.example.com', verified: true },
      { email: 'ada@example.com', verified: true },
    ])
    const r = await signInWith(db, gh, '?next=/issues')
    expect(r!.headers.get('Location')).toBe('/issues')
    expect(r!.headers.get('Set-Cookie')).toMatch(/crashyard_session=/)
    expect(JSON.parse(gh.calls.find((c) => c.url.includes('access_token'))!.body!).code_verifier).toBeTruthy()
    expect((await people.userById(db, ada.id))?.github_id).toBe(42)
    const again = await signInWith(db, gitHub({ id: 42, login: 'ada' }, []))
    expect(again!.headers.get('Set-Cookie')).toMatch(/crashyard_session=/)
  })

  it('refuses an unverified email, someone unknown, and a callback from another browser', async () => {
    const db = sqliteD1()
    await setSetting(db, GITHUB_KEY, APP, null, NOW)
    await people.createUser(db, { email: 'ada@example.com', name: 'Ada', role: 'owner', createdBy: null }, NOW)
    const r = await signInWith(db, gitHub({ id: 7, login: 'mallory' }, [{ email: 'ada@example.com', verified: false }]))
    expect(r!.headers.get('Location')).toBe('/signin?error=github-unknown')
    const start = await handleGitHub('start', {
      request: new Request(`${BASE}/auth/github/start`),
      db,
      base: BASE,
      who: null,
      now: NOW,
    })
    const state = new URL(start!.headers.get('Location')!).searchParams.get('state')
    const elsewhere = await handleGitHub('callback', {
      request: new Request(`${BASE}/auth/github/callback?code=c&state=${state}`),
      db,
      base: BASE,
      who: null,
      now: NOW,
    })
    expect(elsewhere!.headers.get('Location')).toBe('/signin?error=github-stale')
  })

  it('joins from an invite with its role, once, and only with the email it names', async () => {
    const db = sqliteD1()
    await setSetting(db, GITHUB_KEY, APP, null, NOW)
    const named = await people.createInvite(db, 'viewer', 'bo@example.com', 'ada@example.com', NOW)
    const wrong = await signInWith(
      db,
      gitHub({ id: 8, login: 'bo' }, [{ email: 'bo@home.example.com', verified: true }]),
      `?invite=${named}`,
    )
    expect(wrong!.headers.get('Location')).toBe(`/invite/${named}?error=github-email`)
    const ok = await signInWith(
      db,
      gitHub({ id: 8, login: 'bo', name: 'Bo' }, [{ email: 'bo@example.com', verified: true }]),
      `?invite=${named}`,
    )
    expect(ok!.headers.get('Location')).toBe('/')
    expect(await people.userByEmail(db, 'bo@example.com')).toMatchObject({ name: 'Bo', role: 'viewer', github_id: 8 })
    const open = await people.createInvite(db, 'member', null, 'ada@example.com', NOW)
    await signInWith(
      db,
      gitHub({ id: 9, login: 'cy' }, [{ email: 'cy@example.com', verified: true }]),
      `?invite=${open}`,
    )
    const reused = await signInWith(
      db,
      gitHub({ id: 10, login: 'dee' }, [{ email: 'dee@example.com', verified: true }]),
      `?invite=${open}`,
    )
    expect(reused!.headers.get('Location')).toBe(`/invite/${open}?error=invite-used`)
  })
})
