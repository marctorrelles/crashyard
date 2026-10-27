// Inbound filters: events a project doesn't want, dropped before they're stored, as Sentry's (Relay's relay-filter and
// Sentry's generic filters). What they catch is copied from their source; src/ingest/AGENTS.md says which version.
import type { NormalizedEvent } from './event'
import { globToRegExp } from './rules'

export type Filters = {
  browserExtensions?: boolean
  localhost?: boolean
  legacyBrowsers?: boolean
  webCrawlers?: boolean
  healthChecks?: boolean
  hydration?: boolean
  chunkLoad?: boolean
  messages?: string[] // globs over "Type: value" and messages
  releases?: string[] // globs over the release
  domains?: string[] // the only origins events may come from; none for any
}

/** The switches, in the order Settings, Filters shows them */
export const FILTER_SWITCHES = [
  'browserExtensions',
  'localhost',
  'legacyBrowsers',
  'webCrawlers',
  'healthChecks',
  'hydration',
  'chunkLoad',
] as const
export const FILTER_LISTS = ['messages', 'releases', 'domains'] as const

/** A project's stored filters; anything else reads as none */
export function parseFilters(json: string | null | undefined): Filters {
  if (!json) return {}
  try {
    const raw = JSON.parse(json) as Record<string, unknown>
    const out: Filters = {}
    for (const key of FILTER_SWITCHES) if (raw[key] === true) out[key] = true
    for (const key of FILTER_LISTS)
      if (Array.isArray(raw[key])) out[key] = (raw[key] as unknown[]).filter((v): v is string => typeof v === 'string')
    return out
  } catch {
    return {}
  }
}

// relay-filter/src/browser_extensions.rs, EXTENSION_EXC_VALUES and EXTENSION_EXC_SOURCES
const EXTENSION_VALUES = new RegExp(
  [
    'top\\.GLOBALS',
    'originalCreateNotification',
    'canvas.contentDocument',
    'MyApp_RemoveAllHighlights',
    'http://tt\\.epicplay\\.com',
    "Can't\\sfind\\svariable:\\sZiteReader",
    'jigsaw\\sis\\snot\\sdefined',
    'ComboSearch\\sis\\snot\\sdefined',
    'http://loading\\.retry\\.widdit\\.com/',
    'atomicFindClose',
    'fb_xd_fragment',
    'bmi_SafeAddOnload',
    'EBCallBackMessageReceived',
    '_gCrWeb',
    'conduitPage',
    "null\\sis\\snot\\san\\sobject\\s\\(evaluating\\s'elt.parentNode'\\)",
    'plugin\\.setSuspendState\\sis\\snot\\sa\\sfunction',
    'Extension\\scontext\\sinvalidated',
    'webkit-masked-url:',
    "can't\\saccess\\sdead\\sobject",
    'Cannot\\sredefine\\sproperty:\\s(solana|ethereum|googletag)',
    "undefined\\sis\\snot\\san\\sobject\\s\\(evaluating\\s'a\\..'\\)",
    'Permission\\sdenied\\sto\\saccess\\sproperty\\s',
    "Can't\\sfind\\svariable:\\sgmo",
  ].join('|'),
  'i',
)
const EXTENSION_SOURCES = new RegExp(
  [
    'graph\\.facebook\\.com',
    'connect\\.facebook\\.net',
    'eatdifferent\\.com\\.woopra-ns\\.com',
    'static\\.woopra\\.com/js/woopra\\.js',
    '^chrome(-extension)?://',
    '^moz-extension://',
    '^safari(-web)?-extension://',
    'webkit-masked-url',
    '127\\.0\\.0\\.1:4001/isrunning',
    'webappstoolbarba\\.texthelp\\.com/',
    'metrics\\.itunes\\.apple\\.com\\.edgesuite\\.net/',
    'kaspersky-labs\\.com',
  ].join('|'),
  'i',
)
const ANONYMOUS_SOURCES = new Set(['<anonymous>', '[native code]'])

// relay-filter/src/web_crawlers.rs, WEB_CRAWLERS less ALLOWED_WEB_CRAWLERS
const CRAWLERS = new RegExp(
  [
    'Mediapartners-Google',
    'AdsBot-Google',
    'Googlebot',
    'FeedFetcher-Google',
    'Storebot-Google',
    'BingBot',
    'BingPreview',
    'Baiduspider',
    'Slurp',
    'Sogou',
    'facebook',
    'meta-',
    'ia_archiver',
    'bots?([/\\s);]|$)',
    'spider([/\\s);]|$)',
    'Slack',
    'Calypso\\sAppCrawler',
    'pingdom',
    'lyticsbot',
    'AWS\\sSecurity\\sScanner',
    'HubSpot\\sCrawler',
    'Bytespider',
    'Better\\sUptime',
    'Cloudflare-Healthchecks',
    'GTmetrix',
    'BrightEdgeOnCrawl',
    'ELB-HealthChecker',
    'naver.me/spd',
    'ClaudeBot',
    'CCBot',
    'OAI-SearchBot',
    'GPTBot',
    'PerplexityBot',
    'Applebot',
    'DuckDuckBot',
    'Lightpanda',
  ].join('|'),
  'i',
)
const ALLOWED_CRAWLERS = /Slackbot\s1\.\d+|SentryUptimeBot|ChatGPT-User/i

// Sentry's HEALTH_CHECK_GLOBS (src/sentry/constants.py), as Relay's patterns: case aside, {a,b} either
const HEALTH_CHECKS = [
  '*healthcheck*',
  '*health-check*',
  '*heartbeat*',
  '*/health{/,}',
  '*/healthy{/,}',
  '*/healthz{/,}',
  '*/health_check{/,}',
  '*/_health{/,}',
  '*/\\[_health\\]{/,}',
  '*/live{/,}',
  '*/livez{/,}',
  '*/ready{/,}',
  '*/readyz{/,}',
  '*/ping{/,}',
  '*/up{/,}',
  '*/actuator/health{/*,}',
  '*/manage/health{/*,}',
].map((g) => globToRegExp(g, { caseless: true, braces: true }))

const relay = (g: string) => globToRegExp(g, { caseless: true, braces: true })
// Sentry's generic filters (src/sentry/ingest/inbound_filters.py): [type glob or none, value glob], any exception
const HYDRATION: [RegExp | null, RegExp][] = [
  [null, relay('*https://reactjs.org/docs/error-decoder.html?invariant={418,419,421,422,423,425}*')],
  [null, relay('*https://react.dev/errors/{418,419,421,422,423,425}*')],
]
const CHUNK_LOAD: [RegExp | null, RegExp][] = [
  [relay('ChunkLoadError'), relay('Loading chunk *')],
  [relay('*Uncaught *'), relay('ChunkLoadError: Loading chunk *')],
  [relay('ChunkLoadError'), relay('Failed to load chunk *')],
  [relay('*Uncaught *'), relay('ChunkLoadError: Failed to load chunk *')],
  [relay('Error'), relay('Uncaught (in promise): ChunkLoadError*')],
]
const anyException = (e: NormalizedEvent, pairs: [RegExp | null, RegExp][]) =>
  e.exceptions.some((x) => pairs.some(([type, value]) => (!type || type.test(x.type)) && value.test(x.value)))

const header = (e: NormalizedEvent, name: string) => e.request?.headers?.find(([k]) => k.toLowerCase() === name)?.[1]

// relay-filter/src/localhost.rs: the URL's host, file:, or a Host or X-Forwarded-Host header, only what Relay checks:
// not server_name, which a phone app may well call localhost
const LOCAL = new Set(['127.0.0.1', 'localhost'])
const isLocalHost = (host: string) => [...LOCAL].some((d) => host === d || host.endsWith(`.${d}`))
function isLocal(e: NormalizedEvent) {
  const url = e.request?.url ?? e.url
  if (url && URL.canParse(url)) {
    const u = new URL(url)
    if (u.protocol === 'file:' || isLocalHost(u.hostname.replace(/^\[|\]$/g, ''))) return true
  }
  for (const name of ['host', 'x-forwarded-host']) {
    const value = header(e, name)
    if (value && LOCAL.has(value.split(':')[0])) return true
  }
  return false
}

/** A browser's family and major version, for the families Relay's legacy filter knows, as uap-core names them */
export function browserOf(ua: string): { family: string; major: number } | null {
  const m = (re: RegExp) => ua.match(re)
  let r: RegExpMatchArray | null
  if ((r = m(/Opera Mini\/(\d+)/))) return { family: 'Opera Mini', major: Number(r[1]) }
  if ((r = m(/OPR\/(\d+)/)) || (r = m(/Opera\/[\d.]+.*Version\/(\d+)/)))
    return { family: /Mobile/.test(ua) ? 'Opera Mobile' : 'Opera', major: Number(r[1]) }
  if ((r = m(/Edge?\/(\d+)/))) return { family: 'Edge', major: Number(r[1]) }
  if ((r = m(/MSIE (\d+)/)) || (r = m(/Trident\/[\d.]+;.*rv:(\d+)/)))
    return { family: /IEMobile/.test(ua) ? 'IE Mobile' : 'IE', major: Number(r[1]) }
  if ((r = m(/Firefox\/(\d+)/)))
    return { family: /Mobile|Tablet/.test(ua) ? 'Firefox Mobile' : 'Firefox', major: Number(r[1]) }
  if ((r = m(/(?:Chrome|CriOS)\/(\d+)/)))
    return {
      family: /CriOS/.test(ua) ? 'Chrome Mobile iOS' : /Mobile/.test(ua) ? 'Chrome Mobile' : 'Chrome',
      major: Number(r[1]),
    }
  if ((r = m(/Android (\d+)/)) && /Version\/[\d.]+.*Safari/.test(ua)) return { family: 'Android', major: Number(r[1]) }
  if ((r = m(/Version\/(\d+)[\d.]*.*Safari\//)))
    return { family: /iPhone|iPad|iPod/.test(ua) ? 'Mobile Safari' : 'Safari', major: Number(r[1]) }
  return null
}

// relay-filter/src/legacy_browsers.rs, the per-browser cut-offs Sentry offers today: below them is legacy
const LEGACY: Record<string, number> = {
  IE: 12,
  'Opera Mini': 35,
  Opera: 100,
  Android: 4,
  Safari: 16,
  Edge: 111,
  Chrome: 111,
  Firefox: 111,
}
export function isLegacy(ua: string) {
  const b = browserOf(ua)
  if (!b) return false
  const family = b.family === 'IE Mobile' ? 'IE' : b.family
  return family in LEGACY && b.major < LEGACY[family]
}

const globs = (list: string[] | undefined) =>
  (list ?? []).filter((g) => g.trim()).map((g) => globToRegExp(g.trim(), { caseless: true, braces: true }))

/** Why an error event is dropped, or null to keep it */
export function filterReason(event: NormalizedEvent, filters: Filters): string | null {
  const first = event.exceptions[0]
  if (filters.browserExtensions && first) {
    if (EXTENSION_VALUES.test(first.value)) return 'browser-extensions'
    // The frame nearest the crash that has a source; Relay stops at a frame without one
    for (const f of [...first.frames].reverse()) {
      if (!f.absPath) break
      if (ANONYMOUS_SOURCES.has(f.absPath)) continue
      if (EXTENSION_SOURCES.test(f.absPath)) return 'browser-extensions'
      break
    }
  }
  if (filters.localhost && isLocal(event)) return 'localhost'
  const ua = header(event, 'user-agent')
  if (filters.webCrawlers && ua && CRAWLERS.test(ua) && !ALLOWED_CRAWLERS.test(ua)) return 'web-crawlers'
  if (filters.legacyBrowsers && ua && isLegacy(ua)) return 'legacy-browsers'
  if (filters.hydration && anyException(event, HYDRATION)) return 'react-hydration-errors'
  if (filters.chunkLoad && anyException(event, CHUNK_LOAD)) return 'chunk-load-error'
  const messages = globs(filters.messages)
  if (messages.length) {
    // relay-filter/src/error_messages.rs: the message, then each exception as "Type: value"
    const texts = [
      event.message,
      ...event.exceptions.map((x) => (x.type && x.value ? `${x.type}: ${x.value}` : x.type || x.value)),
    ].filter(Boolean)
    if (texts.some((t) => messages.some((g) => g.test(t)))) return 'error-message'
  }
  const releases = globs(filters.releases)
  if (event.release && releases.some((g) => g.test(event.release!))) return 'release-version'
  return null
}

/** Why a transaction is dropped, or null: a health check's name, or a release glob */
export function transactionFilterReason(name: string, release: string | undefined, filters: Filters) {
  if (filters.healthChecks && HEALTH_CHECKS.some((g) => g.test(name))) return 'filtered-transaction'
  if (release && globs(filters.releases).some((g) => g.test(release))) return 'release-version'
  return null
}

/**
 * Whether a request's Origin, else Referer, may send: always without one, as Relay; otherwise its host must be one
 * of the domains (`*`, `example.com`, `*.example.com` for it and its subdomains, `https://example.com:8443` for
 * that scheme and port too). No domains is any
 */
export function originAllowed(origin: string | null, domains: string[] | undefined) {
  const list = (domains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean)
  if (!list.length || !origin || list.includes('*') || !URL.canParse(origin)) return true
  const url = new URL(origin)
  return list.some((entry) => {
    const spec = URL.canParse(entry) && entry.includes('://') ? new URL(entry) : null
    const host = spec ? spec.hostname : entry.split(':')[0]
    if (spec && spec.protocol !== url.protocol) return false
    if (spec?.port && spec.port !== url.port) return false
    if (host.startsWith('*.')) return url.hostname === host.slice(2) || url.hostname.endsWith(host.slice(1))
    return url.hostname === host
  })
}
