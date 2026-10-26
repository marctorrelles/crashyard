// Security reports, what browsers send to a page's `report-uri` or `report-to`: Content Security Policy violations,
// as Sentry's /api/<project>/security/ takes them, turned into events of type `csp`, titled and grouped by the
// directive and the blocked URI's host. Pure.

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 1000) : undefined)

/** The content types Relay's security endpoint takes; anything else answers 415 */
export const isSecurityType = (contentType: string | null) => {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase()
  return type === 'application/json' || type === 'application/csp-report' || type === 'application/reports+json'
}

/** At most this many reports from one request (the Reporting API batches them) */
export const MAX_REPORTS = 100

export type CspReport = {
  documentUri?: string
  referrer?: string
  directive: string
  blockedUri: string
  sourceFile?: string
  line?: number
  column?: number
  sample?: string
  disposition?: string
  statusCode?: number
  userAgent?: string
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * The CSP violations in a request's body: `{ "csp-report": { … } }` (report-uri, kebab-case), or the Reporting API's
 * list of `{ type: "csp-violation", url, user_agent, body: { … } }` (report-to, camelCase). Other report types, and
 * reports without a directive, are left out
 */
export function cspReports(body: unknown): CspReport[] {
  const old = obj(obj(body)['csp-report'])
  if (Object.keys(old).length) {
    const directive = str(old['effective-directive']) ?? str(old['violated-directive'])?.split(' ')[0]
    if (!directive) return []
    return [
      {
        documentUri: str(old['document-uri']),
        referrer: str(old.referrer),
        directive,
        blockedUri: str(old['blocked-uri']) ?? '',
        sourceFile: str(old['source-file']),
        line: num(old['line-number']),
        column: num(old['column-number']),
        sample: str(old['script-sample']),
        disposition: str(old.disposition),
        statusCode: num(old['status-code']),
      },
    ]
  }
  const list = Array.isArray(body) ? body : [body]
  return list
    .map(obj)
    .filter((r) => r.type === 'csp-violation')
    .slice(0, MAX_REPORTS)
    .flatMap((r) => {
      const b = obj(r.body)
      const directive = str(b.effectiveDirective) ?? str(b.violatedDirective)?.split(' ')[0]
      if (!directive) return []
      return [
        {
          documentUri: str(b.documentURL) ?? str(r.url),
          referrer: str(b.referrer),
          directive,
          blockedUri: str(b.blockedURL) ?? '',
          sourceFile: str(b.sourceFile),
          line: num(b.lineNumber),
          column: num(b.columnNumber),
          sample: str(b.sample),
          disposition: str(b.disposition),
          statusCode: num(b.statusCode),
          userAgent: str(r.user_agent),
        },
      ]
    })
}

/** What was blocked: a URL's host, or a keyword (`inline`, `eval`, `data`, `blob`, `self`) as it is */
export function blockedOf(uri: string): string {
  if (!uri) return 'self'
  const keyword = uri.replace(/^'|'$/g, '')
  if (/^(inline|eval|wasm-eval|self|data|blob|trusted-types-policy|trusted-types-sink)$/.test(keyword)) return keyword
  try {
    const url = new URL(uri)
    return url.host || url.protocol.replace(/:$/, '')
  } catch {
    return keyword.split(/[/?#]/)[0] || keyword
  }
}

/** A directive's kind, as Sentry's titles say it: `script-src-elem` reads as script */
const kindOf = (directive: string) => directive.replace(/-src(-elem|-attr)?$/, '')

/** A CSP violation's title, after Sentry's: "Blocked 'script' from 'cdn.example.com'" */
export function cspTitle(r: Pick<CspReport, 'directive' | 'blockedUri'>) {
  const blocked = blockedOf(r.blockedUri)
  const kind = kindOf(r.directive)
  if (blocked === 'inline') return `Blocked unsafe inline '${kind}'`
  if (blocked === 'eval' || blocked === 'wasm-eval') return `Blocked unsafe eval() in '${kind}'`
  return `Blocked '${kind}' from '${blocked}'`
}

/**
 * A report as a Sentry event for the usual path (normalizeEvent marks it `csp` by its `csp` part): titled by the
 * directive and what was blocked, grouped by them, its page as the request, the browser as the User-Agent header so
 * the inbound filters read it
 */
export function cspEvent(r: CspReport, extra: { release?: string; environment?: string; userAgent?: string }) {
  const blocked = blockedOf(r.blockedUri)
  const userAgent = r.userAgent ?? extra.userAgent
  return {
    level: 'error',
    platform: 'javascript',
    logentry: { formatted: cspTitle(r) },
    culprit: r.directive,
    release: extra.release,
    environment: extra.environment,
    fingerprint: ['csp', r.directive, blocked],
    tags: {
      'csp.directive': r.directive,
      'csp.blocked': blocked,
      ...(r.disposition && { 'csp.disposition': r.disposition }),
    },
    request: {
      ...(r.documentUri && { url: r.documentUri }),
      headers: [...(userAgent ? [['User-Agent', userAgent]] : []), ...(r.referrer ? [['Referer', r.referrer]] : [])],
    },
    csp: {
      effective_directive: r.directive,
      blocked_uri: r.blockedUri,
      document_uri: r.documentUri,
      source_file: r.sourceFile,
      line_number: r.line,
      column_number: r.column,
      script_sample: r.sample,
      disposition: r.disposition,
      status_code: r.statusCode,
    },
  }
}
