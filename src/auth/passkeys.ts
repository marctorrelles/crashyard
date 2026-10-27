// /auth/*: the passkey ceremonies and signing out, plain JSON handlers ahead of Start (src/auth/AGENTS.md). Each
// ceremony is two calls: options (a challenge, kept in `challenges` for five minutes, one use) and verify (the
// browser's answer, checked by @simplewebauthn/server). Only the dashboard's own pages may call them: the Origin must
// be the dashboard's.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import * as people from '../data/people'
import type { AuthMode } from './mode'
import { clearedCookie, cookieValue, COOKIE, sessionCookie, type Who } from './session'

/** Where passkeys belong: the dashboard's origin, `PUBLIC_URL` when it's set (not on a dev server), else the request's */
export function relyingParty(request: Request, env: Env, dev: boolean) {
  const origin = (!dev && env.PUBLIC_URL?.replace(/\/$/, '')) || new URL(request.url).origin
  return { origin, rpID: new URL(origin).hostname }
}

class Refused extends Error {}
const refuse = (message: string): never => {
  throw new Refused(message)
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
function person(body: Record<string, unknown>) {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 200) : ''
  if (!name) refuse('Add your name.')
  if (!EMAIL.test(email)) refuse('That email doesn’t look right. It should look like you@example.com.')
  return { name, email }
}

// The authenticator's handle for a person, the same for each of their passkeys so a device keeps one per person
const handleOf = async (email: string) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`crashyard:${email}`)))

async function registration(db: D1Database, rp: { rpID: string }, user: { email: string; name: string; id?: number }) {
  const existing = user.id ? await people.passkeysOf(db, user.id) : []
  return generateRegistrationOptions({
    rpName: 'crashyard',
    rpID: rp.rpID,
    userName: user.email,
    userDisplayName: user.name,
    userID: await handleOf(user.email),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({
      id: p.id,
      transports: p.transports ? JSON.parse(p.transports) : undefined,
    })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  })
}

async function verifyRegistration(
  rp: { rpID: string; origin: string },
  challenge: string,
  response: RegistrationResponseJSON,
) {
  const verified = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    requireUserVerification: false,
  }).catch(() => null)
  if (!verified?.verified || !verified.registrationInfo) return refuse('That passkey couldn’t be checked. Try again.')
  return verified.registrationInfo.credential
}

const STALE = 'That took too long. Start again.'

type Context = { request: Request; env: Env; dev: boolean; mode: AuthMode; who: Who | null; now: number }

/** Answers a POST to /auth/<path>; null for a path it doesn't know */
export async function handleAuth(path: string, ctx: Context): Promise<Response | null> {
  const { request, env, dev, now } = ctx
  const db = env.DB
  const rp = relyingParty(request, env, dev)
  const secure = rp.origin.startsWith('https:')
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  if (request.headers.get('Origin') !== new URL(request.url).origin)
    return Response.json({ error: 'Open crashyard and try again from there.' }, { status: 403 })

  // Signing out: a form's POST from the sidebar, then the sign-in page
  if (path === 'signout') {
    const token = cookieValue(request, COOKIE)
    if (token) await people.endSession(db, token)
    return new Response(null, { status: 303, headers: { Location: '/signin', 'Set-Cookie': clearedCookie(secure) } })
  }

  const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
  const signIn = async (userId: number, extra: Record<string, unknown> = {}) => {
    const session = await people.startSession(db, userId, request.headers.get('User-Agent'), now)
    return Response.json(
      { ok: true, ...extra },
      { headers: { 'Set-Cookie': sessionCookie(session.token, session.expires, secure) } },
    )
  }
  const passkeyName = people.deviceName(request.headers.get('User-Agent'))

  try {
    switch (path) {
      // The first owner, with the setup code from the deployment (`SETUP_CODE`), while there's no one
      case 'setup/options': {
        if (ctx.mode !== 'crashyard') refuse('This crashyard signs in through Cloudflare Access.')
        if (await people.userCount(db)) refuse('crashyard is already set up. Sign in instead.')
        if (!env.SETUP_CODE) refuse('Add a secret named SETUP_CODE to the worker first. pnpm run setup makes one.')
        const code = typeof body.code === 'string' ? body.code : ''
        if (!(await sameCode(code, env.SETUP_CODE ?? '')))
          refuse('That setup code isn’t right. Check it and try again.')
        const user = person(body)
        const options = await registration(db, rp, user)
        const id = await people.saveChallenge(db, options.challenge, 'setup', user, now)
        return Response.json({ id, options })
      }
      // While moving over from Access: the person Access let in becomes the first owner, no setup code needed
      case 'claim/options': {
        if (ctx.mode !== 'access' || !ctx.who || ctx.who.email.startsWith('service:')) refuse('Sign in first.')
        if (await people.userCount(db)) refuse('crashyard already has an owner.')
        const user = { email: ctx.who!.email, name: person({ ...body, email: ctx.who!.email }).name }
        const options = await registration(db, rp, user)
        const id = await people.saveChallenge(db, options.challenge, 'setup', user, now)
        return Response.json({ id, options })
      }
      case 'setup/verify':
      case 'claim/verify': {
        const taken = await people.takeChallenge<{ email: string; name: string }>(db, String(body.id), 'setup', now)
        if (!taken) refuse(STALE)
        const { challenge, data } = taken!
        if (await people.userCount(db)) refuse('crashyard is already set up. Sign in instead.')
        const credential = await verifyRegistration(rp, challenge, body.response as RegistrationResponseJSON)
        const user = await people.createUser(db, { ...data, role: 'owner', createdBy: null }, now)
        await people.addPasskey(db, passkeyOf(credential, user.id, passkeyName), now).run()
        const codes = await people.newRecoveryCodes(db, user.id)
        // Claiming keeps Access's session: the passkey is for after the switch
        return path === 'claim/verify' ? Response.json({ ok: true, codes }) : signIn(user.id, { codes })
      }

      // Signing in: any passkey of this crashyard, picked by the browser, so there's no email to type
      case 'signin/options': {
        const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'preferred' })
        const id = await people.saveChallenge(db, options.challenge, 'signin', {}, now)
        return Response.json({ id, options })
      }
      case 'signin/verify': {
        const taken = await people.takeChallenge(db, String(body.id), 'signin', now)
        if (!taken) refuse(STALE)
        const response = body.response as AuthenticationResponseJSON
        const passkey = response?.id ? await people.passkeyById(db, response.id) : null
        if (!passkey)
          refuse(
            'That passkey isn’t one of this crashyard’s. It may have been removed. Try another, or use a recovery code.',
          )
        const verified = await verifyAuthenticationResponse({
          response,
          expectedChallenge: taken!.challenge,
          expectedOrigin: rp.origin,
          expectedRPID: rp.rpID,
          requireUserVerification: false,
          credential: {
            id: passkey!.id,
            publicKey: new Uint8Array(passkey!.public_key as ArrayBuffer),
            counter: passkey!.counter,
            transports: passkey!.transports ? JSON.parse(passkey!.transports) : undefined,
          },
        }).catch(() => null)
        if (!verified?.verified) refuse('That passkey couldn’t be checked. Try again.')
        await people.usedPasskey(db, passkey!.id, verified!.authenticationInfo.newCounter, now)
        return signIn(passkey!.user_id)
      }

      // Another passkey for whoever is signed in
      case 'passkeys/options': {
        if (!ctx.who?.userId) refuse('Sign in first.')
        const user = await people.userById(db, ctx.who!.userId!)
        const options = await registration(db, rp, user!)
        const id = await people.saveChallenge(db, options.challenge, 'register', { userId: user!.id }, now)
        return Response.json({ id, options })
      }
      case 'passkeys/verify': {
        const taken = await people.takeChallenge<{ userId: number }>(db, String(body.id), 'register', now)
        if (!taken || taken.data.userId !== ctx.who?.userId) refuse(STALE)
        const credential = await verifyRegistration(rp, taken!.challenge, body.response as RegistrationResponseJSON)
        await people.addPasskey(db, passkeyOf(credential, taken!.data.userId, passkeyName), now).run()
        return Response.json({ ok: true, name: passkeyName })
      }

      // Joining from an invite link: the role it gives, the email it names if it names one
      case 'invite/options': {
        const invite = await people.inviteOf(db, String(body.token ?? ''), now)
        if (!invite?.usable) refuse('This invite has expired or was already used. Ask whoever sent it for a new one.')
        const user = person(invite!.email ? { ...body, email: invite!.email } : body)
        if (await people.userByEmail(db, user.email))
          refuse('Someone with that email is already here. Sign in instead.')
        const options = await registration(db, rp, user)
        const id = await people.saveChallenge(db, options.challenge, 'invite', { ...user, hash: invite!.hash }, now)
        return Response.json({ id, options })
      }
      case 'invite/verify': {
        type Joining = { email: string; name: string; hash: string }
        const taken = await people.takeChallenge<Joining>(db, String(body.id), 'invite', now)
        if (!taken) refuse(STALE)
        const credential = await verifyRegistration(rp, taken!.challenge, body.response as RegistrationResponseJSON)
        const invite = await db
          .prepare('SELECT * FROM invites WHERE hash = ?')
          .bind(taken!.data.hash)
          .first<people.Invite>()
        // One use, even from two tabs: the invite is taken first, and only then the person made
        const used = await people.useInvite(db, taken!.data.hash, null, now).run()
        if (!invite || !used.meta.changes)
          refuse('This invite has expired or was already used. Ask whoever sent it for a new one.')
        const user = await people
          .createUser(
            db,
            { email: taken!.data.email, name: taken!.data.name, role: invite!.role, createdBy: invite!.created_by },
            now,
          )
          .catch(() => refuse('Someone with that email is already here. Sign in instead.'))
        await db.batch([
          people.addPasskey(db, passkeyOf(credential, user.id, passkeyName), now),
          db.prepare('UPDATE invites SET used_by = ? WHERE hash = ?').bind(user.id, taken!.data.hash),
        ])
        const codes = await people.newRecoveryCodes(db, user.id)
        return signIn(user.id, { codes })
      }

      // A recovery code, for someone whose passkeys are all gone: signs in, once per code
      case 'recover': {
        const email = typeof body.email === 'string' ? body.email : ''
        const code = typeof body.code === 'string' ? body.code : ''
        const user = await people.useRecoveryCode(db, email, code, now)
        if (!user) refuse('That email and recovery code don’t match. Check both and try again.')
        return signIn(user!.id, { left: await people.recoveryCodesLeft(db, user!.id) })
      }
    }
  } catch (error) {
    if (error instanceof Refused) return Response.json({ error: error.message }, { status: 400 })
    throw error
  }
  return null
}

const passkeyOf = (
  credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] },
  userId: number,
  name: string,
) => ({
  id: credential.id,
  userId,
  publicKey: credential.publicKey,
  counter: credential.counter,
  transports: credential.transports,
  name,
})

// Compared as digests of the typed code without dashes or spaces, so the time taken says nothing about the guess
async function sameCode(typed: string, expected: string) {
  const digest = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(people.normalCode(s))))
  const [x, y] = await Promise.all([digest(typed), digest(expected)])
  return !!people.normalCode(typed) && x.every((v, i) => v === y[i])
}
