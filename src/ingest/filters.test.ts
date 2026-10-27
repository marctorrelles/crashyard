import { describe, expect, it } from 'vitest'
import { type NormalizedEvent, normalizeEvent } from './event'
import { browserOf, filterReason, type Filters, originAllowed, parseFilters, transactionFilterReason } from './filters'

const event = (over: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  id: 'a'.repeat(32),
  timestamp: 0,
  received: 0,
  level: 'error',
  platform: 'javascript',
  type: 'error',
  title: 'TypeError: x is undefined',
  culprit: '',
  message: '',
  exceptions: [
    {
      type: 'TypeError',
      value: 'x is undefined',
      frames: [{ inApp: true, absPath: 'https://app.example.com/main.js' }],
    },
  ],
  tags: {},
  contexts: {},
  breadcrumbs: [],
  debugImages: [],
  request: { url: 'https://app.example.com/', headers: [['User-Agent', CHROME]] },
  ...over,
})
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const ua = (agent: string) => event({ request: { url: 'https://app.example.com/', headers: [['user-agent', agent]] } })
const ALL: Filters = {
  browserExtensions: true,
  localhost: true,
  legacyBrowsers: true,
  webCrawlers: true,
  healthChecks: true,
  hydration: true,
  chunkLoad: true,
}
const exception = (type: string, value: string, absPath?: string) =>
  event({ exceptions: [{ type, value, frames: absPath ? [{ inApp: true, absPath }] : [] }] })

describe('inbound filters', () => {
  it('let a normal event through with every filter on', () => {
    expect(filterReason(event(), { ...ALL, messages: ['*timeout*'], releases: ['0.*'] })).toBeNull()
    expect(filterReason(ua(CHROME), {})).toBeNull()
  })

  it('catch browser extensions by their messages and by the source nearest the crash', () => {
    expect(filterReason(exception('Error', 'Extension context invalidated.'), ALL)).toBe('browser-extensions')
    expect(filterReason(exception('Error', 'boom', 'chrome-extension://abc/content.js'), ALL)).toBe(
      'browser-extensions',
    )
    expect(filterReason(exception('Error', 'boom', 'safari-web-extension://x/a.js'), ALL)).toBe('browser-extensions')
    expect(filterReason(exception('Error', 'Extension context invalidated.'), {})).toBeNull()
  })

  it('catch localhost by URL or Host header, as Relay, and not by server_name', async () => {
    expect(filterReason(event({ request: { url: 'http://localhost:5173/' } }), ALL)).toBe('localhost')
    expect(filterReason(event({ request: { url: 'http://127.0.0.1/x' } }), ALL)).toBe('localhost')
    expect(filterReason(event({ request: { headers: [['Host', 'localhost:3000']] } }), ALL)).toBe('localhost')
    // A phone app's server_name may well be localhost: Relay doesn't read it
    expect(filterReason(await normalizeEvent({ message: 'x', server_name: 'localhost' }), ALL)).toBeNull()
    expect(filterReason(event({ request: { url: 'https://notlocalhost.com/' } }), ALL)).toBeNull()
  })

  it('catch legacy browsers below Sentry’s cut-offs', () => {
    expect(filterReason(ua('Mozilla/5.0 (Windows NT 6.3; Trident/7.0; rv:11.0) like Gecko'), ALL)).toBe(
      'legacy-browsers',
    )
    expect(filterReason(ua(CHROME.replace('141.0.0.0', '109.0.0.0')), ALL)).toBe('legacy-browsers')
    const safari15 =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Safari/605.1.15'
    expect(filterReason(ua(safari15), ALL)).toBe('legacy-browsers')
    expect(filterReason(ua(safari15.replace('15.6', '17.4')), ALL)).toBeNull()
    // Mobile Safari is a family of its own in uap-core, which Relay's Safari cut-off doesn't name
    expect(
      browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 15_0) AppleWebKit/605 Version/15.0 Mobile/15E148 Safari/604.1'),
    ).toEqual({ family: 'Mobile Safari', major: 15 })
    expect(browserOf(`${CHROME} Edg/141.0.0.0`)?.family).toBe('Edge')
  })

  it('catch web crawlers by Relay’s list, not the allowed ones', () => {
    expect(filterReason(ua('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), ALL)).toBe(
      'web-crawlers',
    )
    expect(filterReason(ua('Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'), ALL)).toBe('web-crawlers')
    expect(filterReason(ua('Slackbot 1.0 (+https://api.slack.com/robots)'), ALL)).toBeNull()
  })

  it('catch health-check transactions by Sentry’s globs', () => {
    for (const name of ['GET /health', '/healthz', '/api/ping', 'GET /actuator/health/liveness', 'healthcheck'])
      expect(transactionFilterReason(name, undefined, ALL), name).toBe('filtered-transaction')
    expect(transactionFilterReason('GET /api/users', undefined, ALL)).toBeNull()
    expect(transactionFilterReason('/health', undefined, {})).toBeNull()
  })

  it('catch React hydration errors and ChunkLoadError', () => {
    expect(
      filterReason(
        exception('Error', 'Minified React error #418; visit https://react.dev/errors/418?args[]= for'),
        ALL,
      ),
    ).toBe('react-hydration-errors')
    expect(filterReason(exception('Error', 'https://react.dev/errors/310'), ALL)).toBeNull()
    expect(filterReason(exception('ChunkLoadError', 'Loading chunk 3662 failed.'), ALL)).toBe('chunk-load-error')
    expect(filterReason(exception('Error', 'Uncaught (in promise): ChunkLoadError: x'), ALL)).toBe('chunk-load-error')
    expect(filterReason(exception('ChunkLoadError', 'Loading chunk 1 failed.'), {})).toBeNull()
  })

  it('catch error messages and releases by glob, case aside', () => {
    expect(filterReason(event(), { messages: ['typeerror: x is*'] })).toBe('error-message')
    expect(
      filterReason(event({ exceptions: [], message: 'Network request failed' }), { messages: ['*network*'] }),
    ).toBe('error-message')
    expect(filterReason(event({ release: 'app@0.9.1' }), { releases: ['app@0.*'] })).toBe('release-version')
    expect(filterReason(event({ release: 'app@1.0' }), { releases: ['app@0.*'] })).toBeNull()
    expect(transactionFilterReason('GET /', 'app@0.9', { releases: ['app@0.*'] })).toBe('release-version')
  })

  it('allow only the domains listed, by Origin or Referer, and anything without one', () => {
    const domains = ['app.example.com', '*.example.org', 'https://shop.example.net:8443']
    expect(originAllowed('https://app.example.com', domains)).toBe(true)
    expect(originAllowed('https://evil.com/page', domains)).toBe(false)
    expect(originAllowed('https://a.b.example.org', domains)).toBe(true)
    expect(originAllowed('https://example.org', domains)).toBe(true)
    expect(originAllowed('http://shop.example.net:8443', domains)).toBe(false)
    expect(originAllowed(null, domains)).toBe(true)
    expect(originAllowed('https://evil.com', [])).toBe(true)
    expect(originAllowed('https://evil.com', ['*'])).toBe(true)
  })

  it('read stored filters, and nothing from what isn’t', () => {
    expect(parseFilters('{"localhost":true,"messages":["a",1],"x":true}')).toEqual({ localhost: true, messages: ['a'] })
    expect(parseFilters('nope')).toEqual({})
    expect(parseFilters(null)).toEqual({})
  })
})
