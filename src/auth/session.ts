// Who a dashboard request is, in either mode, and the session cookie. src/server.ts passes the answer on as headers.
import { type Role, sessionUser } from '../data/people'
import { viewerOf } from './access'
import type { AuthMode } from './mode'

export const COOKIE = 'crashyard_session'

/** Who's asking: their email (activity, assignees and preferences are by email), role, and in crashyard mode their
 * user id and session; `cookie` when the session was renewed and the browser needs it again */
export type Who = { email: string; role: Role; userId?: number; session?: string; cookie?: string }

export const cookieValue = (request: Request, name: string) =>
  request.headers
    .get('Cookie')
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1)

/** The session cookie: only the worker reads it (HttpOnly), sent on top-level navigations from elsewhere (Lax) so a
 * link to an issue opens signed in */
export const sessionCookie = (token: string, expires: number, secure: boolean) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expires).toUTCString()}${secure ? '; Secure' : ''}`
export const clearedCookie = (secure: boolean) =>
  `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`

/**
 * Who a request is. A local dev server is dev@localhost, an owner, unless `AUTH` is `crashyard` (to work on sign-in
 * itself). Access: its token's email, an owner (who may come in is Access's policy), or a service token, a viewer.
 * crashyard: the session cookie's person.
 */
export async function whoIs(
  request: Request,
  env: Env,
  mode: AuthMode,
  dev: boolean,
  now: number,
): Promise<Who | null> {
  if (dev && (env.AUTH as string) !== 'crashyard') return { email: 'dev@localhost', role: 'owner' }
  if (mode === 'access') {
    const viewer = await viewerOf(request, env, dev)
    return viewer && { email: viewer.email, role: viewer.email.startsWith('service:') ? 'viewer' : 'owner' }
  }
  const token = cookieValue(request, COOKIE)
  if (!token) return null
  const found = await sessionUser(env.DB, token, now)
  if (!found) return null
  const secure = new URL(request.url).protocol === 'https:'
  return {
    email: found.user.email,
    role: found.user.role,
    userId: found.user.id,
    session: found.hash,
    cookie: found.renewed ? sessionCookie(token, found.renewed, secure) : undefined,
  }
}
