import { describe, expect, it } from 'vitest'
import { viewerOf } from './access'

const request = (headers: Record<string, string> = {}) => new Request('https://crashes.example.com/', { headers })
const configured = { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud' }

describe('viewerOf', () => {
  it('lets a local dev server in, Access or not', async () => {
    expect(await viewerOf(request(), {}, true)).toEqual({ email: 'dev@localhost' })
    expect(await viewerOf(request(), configured, true)).toEqual({ email: 'dev@localhost' })
  })

  it('keeps a deployment without Access closed', async () => {
    expect(await viewerOf(request(), {}, false)).toBeNull()
    expect(await viewerOf(request(), { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com' }, false)).toBeNull()
  })

  it('refuses a request with no token, or one that doesn’t verify, once Access is set up', async () => {
    expect(await viewerOf(request(), configured, false)).toBeNull()
    expect(await viewerOf(request({ 'Cf-Access-Jwt-Assertion': 'not.a.token' }), configured, false)).toBeNull()
  })
})
