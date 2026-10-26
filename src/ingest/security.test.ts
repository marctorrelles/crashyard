import { describe, expect, it } from 'vitest'
import { normalizeEvent } from './event'
import { fingerprintOf } from './grouping'
import { blockedOf, cspEvent, cspReports, cspTitle, isSecurityType } from './security'

// As Firefox and Chrome send them: report-uri's kebab-case, and the Reporting API's list
const reportUri = {
  'csp-report': {
    'document-uri': 'https://app.example.com/songs?id=1',
    referrer: '',
    'violated-directive': 'script-src-elem',
    'effective-directive': 'script-src-elem',
    'original-policy': "default-src 'self'; report-uri /api/1/security/",
    disposition: 'enforce',
    'blocked-uri': 'https://cdn.evil.example/lib.js',
    'line-number': 12,
    'source-file': 'https://app.example.com/songs',
    'status-code': 200,
  },
}
const reportTo = [
  {
    type: 'csp-violation',
    age: 10,
    url: 'https://app.example.com/other',
    user_agent: 'Mozilla/5.0 Chrome/130.0',
    body: {
      documentURL: 'https://app.example.com/other',
      effectiveDirective: 'script-src-elem',
      blockedURL: 'https://cdn.evil.example/other.js',
      disposition: 'enforce',
      statusCode: 200,
    },
  },
  { type: 'deprecation', url: 'https://app.example.com/', body: { id: 'x' } },
  {
    type: 'csp-violation',
    url: 'https://app.example.com/',
    body: { effectiveDirective: 'style-src-attr', blockedURL: 'inline' },
  },
]

describe('security reports', () => {
  it('reads both shapes, leaving other report types out', () => {
    expect(cspReports(reportUri)).toMatchObject([
      { directive: 'script-src-elem', blockedUri: 'https://cdn.evil.example/lib.js', line: 12 },
    ])
    expect(cspReports(reportTo)).toMatchObject([
      {
        directive: 'script-src-elem',
        documentUri: 'https://app.example.com/other',
        userAgent: 'Mozilla/5.0 Chrome/130.0',
      },
      { directive: 'style-src-attr', blockedUri: 'inline' },
    ])
    expect(cspReports({ nothing: true })).toEqual([])
    expect([
      isSecurityType('application/csp-report'),
      isSecurityType('application/reports+json; charset=utf-8'),
    ]).toEqual([true, true])
    expect(isSecurityType('text/plain')).toBe(false)
  })

  it('titles by the directive and the blocked host, as Sentry does', () => {
    expect(cspTitle({ directive: 'script-src-elem', blockedUri: 'https://cdn.evil.example/lib.js' })).toBe(
      "Blocked 'script' from 'cdn.evil.example'",
    )
    expect(cspTitle({ directive: 'style-src-attr', blockedUri: 'inline' })).toBe("Blocked unsafe inline 'style'")
    expect(cspTitle({ directive: 'script-src', blockedUri: 'eval' })).toBe("Blocked unsafe eval() in 'script'")
    expect([blockedOf('data'), blockedOf(''), blockedOf('chrome-extension://abc/x.js')]).toEqual([
      'data',
      'self',
      'abc',
    ])
  })

  it('becomes an event of type csp, grouped by directive and host whatever the page or file', async () => {
    const [a] = cspReports(reportUri)
    const [b] = cspReports(reportTo)
    const ea = await normalizeEvent(cspEvent(a, { environment: 'production', userAgent: 'Firefox' }), 0)
    const eb = await normalizeEvent(cspEvent(b, {}), 0)
    expect(ea).toMatchObject({
      type: 'csp',
      title: "Blocked 'script' from 'cdn.evil.example'",
      culprit: 'script-src-elem',
      environment: 'production',
      tags: { 'csp.directive': 'script-src-elem', 'csp.blocked': 'cdn.evil.example' },
    })
    expect(ea.request?.headers).toContainEqual(['User-Agent', 'Firefox'])
    expect(eb.request?.headers).toContainEqual(['User-Agent', 'Mozilla/5.0 Chrome/130.0'])
    expect(await fingerprintOf(ea)).toBe(await fingerprintOf(eb))
    const [, inline] = cspReports(reportTo)
    expect(await fingerprintOf(await normalizeEvent(cspEvent(inline, {}), 0))).not.toBe(await fingerprintOf(ea))
  })
})
