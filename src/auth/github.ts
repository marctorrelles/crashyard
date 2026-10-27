// Sign in with GitHub, optional, through a GitHub App the owner creates in one click (the manifest flow): crashyard
// keeps its client id and secret in `settings`. Signing in is OAuth with a state and PKCE; GitHub only says who
// someone is, crashyard decides who comes in: someone already here (by the GitHub account they used before, else a
// verified email of theirs), or someone with an invite.
import * as people from '../data/people'
import { getSetting, setSetting } from '../data/settings'
import { sessionCookie } from './session'

export const GITHUB_KEY = 'auth.github'
export type GitHubApp = { appId: number; slug: string; clientId: string; clientSecret: string; owner: string }

const STATE_COOKIE = 'crashyard_github'
const API = 'https://api.github.com'
const HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'crashyard' }

export const gitHubApp = (db: D1Database) => getSetting<GitHubApp | null>(db, GITHUB_KEY, null)

/** What GitHub needs to create the app: its name (at most 34 characters; it can be changed there), where crashyard
 * is, where GitHub sends the person back, and the one permission sign-in needs, reading their email addresses */
export function manifest(base: string) {
  return {
    name: `crashyard ${new URL(base).hostname}`.slice(0, 34).trim(),
    url: base,
    redirect_url: `${base}/auth/github/created`,
    callback_urls: [`${base}/auth/github/callback`],
    public: false,
    request_oauth_on_install: false,
    default_permissions: { emails: 'read' },
  }
}

/** Where the owner's browser posts the manifest: their account, or an organisation they manage */
export async function startApp(db: D1Database, base: string, org: string | null, by: string, now: number) {
  // An hour: creating the app on GitHub can take a while
  const state = await people.saveChallenge(db, '', 'github-app', { by }, now, 60 * 60_000)
  const path = org ? `organizations/${encodeURIComponent(org)}/settings/apps/new` : 'settings/apps/new'
  return { action: `https://github.com/${path}?state=${state}`, manifest: JSON.stringify(manifest(base)) }
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const back = (to: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { Location: to, ...headers } })

/** Only a path on this site */
const safeNext = (next: unknown) =>
  typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/'

type Context = {
  request: Request
  db: D1Database
  base: string
  who: { email: string; role: people.Role } | null
  now: number
  fetch?: typeof fetch
}

/** GET /auth/github/<step>: null for a step it doesn't know */
export async function handleGitHub(step: string, ctx: Context): Promise<Response | null> {
  const { request, db, base, now } = ctx
  const call = ctx.fetch ?? fetch
  const url = new URL(request.url)
  const secure = base.startsWith('https:')
  const clearState = `${STATE_COOKIE}=; Path=/auth/github; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`

  // Back from creating the app: its id, client id and secret, kept for signing in
  if (step === 'created') {
    if (!ctx.who || !people.reaches(ctx.who.role, 'owner')) return back('/signin')
    const taken = await people.takeChallenge(db, url.searchParams.get('state') ?? '', 'github-app', now)
    const code = url.searchParams.get('code')
    if (!taken || !code) return back('/settings/people?github=stale')
    const response = await call(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: HEADERS,
    })
    if (!response.ok) return back('/settings/people?github=failed')
    const app = (await response.json()) as {
      id: number
      slug: string
      client_id: string
      client_secret: string
      owner?: { login?: string }
    }
    const value: GitHubApp = {
      appId: app.id,
      slug: app.slug,
      clientId: app.client_id,
      clientSecret: app.client_secret,
      owner: app.owner?.login ?? '',
    }
    await setSetting(db, GITHUB_KEY, value, ctx.who.email, now)
    return back('/settings/people?github=added')
  }

  const app = await gitHubApp(db)
  if (!app) return back('/signin')
  const callback = `${base}/auth/github/callback`

  // Off to GitHub, with a state bound to this browser by a cookie, and PKCE
  if (step === 'start') {
    const verifier = people.randomToken(32)
    const challenge = base64url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    )
    const invite = url.searchParams.get('invite')
    const state = await people.saveChallenge(
      db,
      verifier,
      'github',
      { next: safeNext(url.searchParams.get('next')), invite },
      now,
      10 * 60_000,
    )
    const authorize = new URL('https://github.com/login/oauth/authorize')
    authorize.search = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: callback,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString()
    return back(authorize.toString(), {
      'Set-Cookie': `${STATE_COOKIE}=${state}; Path=/auth/github; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`,
    })
  }

  if (step !== 'callback') return null
  const state = url.searchParams.get('state') ?? ''
  const cookie = request.headers
    .get('Cookie')
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${STATE_COOKIE}=`))
    ?.slice(STATE_COOKIE.length + 1)
  const taken =
    cookie === state
      ? await people.takeChallenge<{ next: string; invite: string | null }>(db, state, 'github', now)
      : null
  if (!taken) return back('/signin?error=github-stale', { 'Set-Cookie': clearState })
  const { invite } = taken.data
  const fail = (error: string) =>
    back(invite ? `/invite/${invite}?error=${error}` : `/signin?error=${error}`, { 'Set-Cookie': clearState })
  const code = url.searchParams.get('code')
  if (!code) return fail('github-cancelled')

  const exchange = await call('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { ...HEADERS, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      redirect_uri: callback,
      code_verifier: taken.challenge,
    }),
  })
  const token = exchange.ok ? ((await exchange.json()) as { access_token?: string }).access_token : undefined
  if (!token) return fail('github-failed')
  const auth = { headers: { ...HEADERS, Authorization: `Bearer ${token}` } }
  const [userResponse, emailsResponse] = await Promise.all([
    call(`${API}/user`, auth),
    call(`${API}/user/emails`, auth),
  ])
  if (!userResponse.ok || !emailsResponse.ok) return fail('github-failed')
  const user = (await userResponse.json()) as { id: number; login: string; name: string | null }
  const emails = (await emailsResponse.json()) as { email: string; verified: boolean; primary: boolean }[]
  const verified = emails.filter((e) => e.verified).map((e) => e.email.toLowerCase())
  const primary = emails.find((e) => e.primary && e.verified)?.email.toLowerCase() ?? verified[0]

  const signIn = async (userId: number, next: string) => {
    const session = await people.startSession(db, userId, request.headers.get('User-Agent'), now)
    const headers = new Headers({ Location: next })
    headers.append('Set-Cookie', sessionCookie(session.token, session.expires, secure))
    headers.append('Set-Cookie', clearState)
    return new Response(null, { status: 303, headers })
  }

  // Someone who signed in with this account before
  const linked = await people.userByGitHub(db, user.id)
  if (linked) return signIn(linked.id, taken.data.next)
  // Someone already here, by a verified email of theirs: the account is theirs from now on
  for (const email of verified) {
    const known = await people.userByEmail(db, email)
    if (known && !known.github_id) {
      await people.linkGitHub(db, known.id, user.id)
      return signIn(known.id, taken.data.next)
    }
  }
  // Someone joining from an invite: its role, and the email it names if it names one
  if (invite) {
    const found = await people.inviteOf(db, invite, now)
    if (!found?.usable) return fail('invite-used')
    if (found.email && !verified.includes(found.email)) return fail('github-email')
    const email = found.email ?? primary
    if (!email) return fail('github-no-email')
    const used = await people.useInvite(db, found.hash, null, now).run()
    if (!used.meta.changes) return fail('invite-used')
    const created = await people.createUser(
      db,
      { email, name: user.name || user.login, role: found.role, createdBy: found.created_by, githubId: user.id },
      now,
    )
    await db.prepare('UPDATE invites SET used_by = ? WHERE hash = ?').bind(created.id, found.hash).run()
    return signIn(created.id, '/')
  }
  return fail('github-unknown')
}
