import { createRemoteJWKSet, jwtVerify } from 'jose'

/** Who is signed in to the dashboard, from Cloudflare Access's token */
export type Viewer = { email: string }

type AccessConfig = { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string }

// One key set per team domain, cached by jose across requests in this isolate
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

/**
 * Checks the request's Access token. Null when it's missing or doesn't verify. Without Access configured, a local dev
 * server lets everyone in as dev@localhost, and anywhere else nobody gets in: a deployment that forgot Access stays
 * closed rather than open.
 */
export async function viewerOf(request: Request, config: AccessConfig, dev: boolean): Promise<Viewer | null> {
  const team = config.ACCESS_TEAM_DOMAIN?.replace(/^https?:\/\//, '').replace(/\/$/, '')
  if (!team || !config.ACCESS_AUD) return dev ? { email: 'dev@localhost' } : null
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token) return null
  let keys = keySets.get(team)
  if (!keys) keySets.set(team, (keys = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`))))
  try {
    const { payload } = await jwtVerify(token, keys, { issuer: `https://${team}`, audience: config.ACCESS_AUD })
    return typeof payload.email === 'string' ? { email: payload.email } : null
  } catch {
    return null
  }
}
