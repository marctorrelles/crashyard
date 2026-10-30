// Who a dashboard request is, and the session cookie. src/server.ts passes the answer on as headers.
import { type Role, sessionUser } from '../data/people'
import { DEMO_COOKIE, DEMO_VIEWER, isDemo } from '../demo'

export const COOKIE = 'crashyard_session'

/** Who's asking: their email (activity, assignees and preferences are by email), role, user id and session (none on a
 * dev server); `cookie` when the session was renewed and the browser needs it again */
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
 * Who a request is: the session cookie's person. A local dev server is dev@localhost, an owner, unless `AUTH` is
 * `crashyard` (`AUTH=crashyard pnpm dev`, to work on sign-in itself). In the demo (`DEMO=1`, dev servers too), the
 * Enter demo cookie's viewer, else no one: a session cookie isn't read there.
 */
export async function whoIs(request: Request, env: Env, dev: boolean, now: number): Promise<Who | null> {
  if (isDemo(env)) return cookieValue(request, DEMO_COOKIE) === '1' ? { ...DEMO_VIEWER } : null
  if (dev && (env as { AUTH?: string }).AUTH !== 'crashyard') return { email: 'dev@localhost', role: 'owner' }
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
