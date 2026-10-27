/** How people sign in: crashyard's own passkeys and sessions, or Cloudflare Access in front */
export type AuthMode = 'crashyard' | 'access'

/** `AUTH` when it names one, else Access when its audience is set (a deployment from before keeps working), else
 * crashyard's own */
export const authMode = (env: { AUTH?: string; ACCESS_AUD?: string }): AuthMode =>
  env.AUTH === 'crashyard' || env.AUTH === 'access' ? env.AUTH : env.ACCESS_AUD ? 'access' : 'crashyard'
