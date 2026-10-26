// A Sentry event (https://develop.sentry.dev/sdk/data-model/event-payloads/) as the SDKs send it, turned into the one
// shape crashyard stores: its exceptions and their frames, the title and culprit, tags, contexts and breadcrumbs,
// with secrets scrubbed and the user reduced to a hash.
import { scrub, scrubText } from './scrub'

export type Frame = {
  function?: string
  module?: string
  filename?: string
  absPath?: string
  lineno?: number
  colno?: number
  inApp: boolean
  package?: string // the image (Mach-O, ELF) the frame is in, for native code
  instructionAddr?: string
  imageAddr?: string
  context?: { pre: string[]; line?: string; post: string[] }
  symbolicated?: boolean // mapped back to the source with an uploaded file: a second pass leaves it be
}
export type ExceptionValue = {
  type: string
  value: string
  module?: string
  handled?: boolean
  mechanism?: string
  synthetic?: boolean // made by the SDK to carry a stack (captureMessage), not thrown
  frames: Frame[] // oldest first: the last frame is where it happened
}
/** The HTTP request an event happened in, scrubbed: headers as pairs, the body as text of 8 KB at most */
export type RequestInfo = { method?: string; url?: string; query?: string; headers?: [string, string][]; body?: string }
/** A thread at the time of the event. The one whose stack is the exception's keeps no frames of its own */
export type Thread = { id?: string; name?: string; crashed?: boolean; current?: boolean; frames: Frame[] }
export type DebugImage = { type: string; debugId?: string; codeFile?: string; imageAddr?: string; imageSize?: number }
export type Breadcrumb = {
  timestamp?: number
  category?: string
  message?: string
  level?: string
  type?: string
  data?: unknown
}

export type NormalizedEvent = {
  id: string
  timestamp: number // ms
  received: number // ms
  level: string
  platform: string
  release?: string
  environment?: string
  dist?: string
  type: 'error' | 'message'
  title: string
  culprit: string
  message: string
  exceptions: ExceptionValue[] // oldest first, as Sentry sends them: the last is the one that was thrown
  threads?: Thread[] // the crashed or current one first; events stored before threads were kept have none
  tags: Record<string, string>
  contexts: Record<string, unknown>
  breadcrumbs: Breadcrumb[]
  userHash?: string
  fingerprint?: string[]
  transaction?: string
  traceId?: string
  url?: string
  sdk?: { name?: string; version?: string }
  debugImages: DebugImage[]
  request?: RequestInfo
  extra?: Record<string, unknown> // the SDK's extra data, scrubbed, 16 KB of JSON at most
  /** What was cut to keep the event within its limits: `extra`, `request body`, or what `trimEvent` names */
  _trimmed?: string[]
  /** Debug files the event needed and crashyard didn't have, so its frames stay addresses (set by symbolication) */
  missingDebugFiles?: { debugId: string; codeFile?: string; type: string }[]
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const arr = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : Array.isArray(obj(v).values) ? (obj(v).values as unknown[]) : []
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const LEVELS = new Set(['fatal', 'error', 'warning', 'info', 'debug'])
const LEVEL_ALIASES: Record<string, string> = { critical: 'fatal', warn: 'warning', log: 'info' }

/** An SDK timestamp: seconds since 1970 (a float), or an ISO string; in ms */
export function timestampOf(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 1000)
  if (typeof v === 'string') {
    const n = Number(v)
    if (v.trim() !== '' && Number.isFinite(n)) return Math.round(n * 1000)
    const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`)
    if (Number.isFinite(t)) return t
  }
  return undefined
}

export function eventIdOf(v: unknown): string | undefined {
  const id = typeof v === 'string' ? v.replace(/-/g, '').toLowerCase() : ''
  return /^[0-9a-f]{32}$/.test(id) ? id : undefined
}

function frameOf(raw: unknown): Frame {
  const f = obj(raw)
  const lines = (v: unknown) => arr(v).filter((s): s is string => typeof s === 'string')
  const contextLine = str(f.context_line)
  return {
    function: str(f.function) ?? str(f.raw_function),
    module: str(f.module),
    filename: str(f.filename),
    absPath: str(f.abs_path),
    lineno: num(f.lineno),
    colno: num(f.colno),
    inApp: f.in_app === true,
    package: str(f.package),
    instructionAddr: str(f.instruction_addr),
    imageAddr: str(f.image_addr),
    context:
      contextLine !== undefined
        ? { pre: lines(f.pre_context), line: contextLine, post: lines(f.post_context) }
        : undefined,
  }
}

const framesOf = (stacktrace: unknown) => arr(obj(stacktrace).frames).map(frameOf)

/** The threads kept, at most 32 of 100 frames each (the innermost) */
export const MAX_THREADS = 32
export const THREAD_FRAMES = 100

function exceptionsOf(event: Json, threads: Json[], used: Set<Json>): ExceptionValue[] {
  return arr(event.exception).map((raw) => {
    const e = obj(raw)
    let frames = framesOf(e.stacktrace)
    const thread =
      threads.find((t) => e.thread_id !== undefined && String(t.id) === String(e.thread_id)) ??
      threads.find((t) => t.crashed === true)
    // Native crashes (sentry-cocoa, sentry-native) put the stack on the crashed thread rather than on the exception
    if (!frames.length && thread) frames = framesOf(thread.stacktrace)
    // Either way the thread's stack is the exception's: it's kept once, there
    if (frames.length && thread) used.add(thread)
    const mechanism = obj(e.mechanism)
    return {
      type: str(e.type) ?? 'Error',
      value: scrubText(str(e.value) ?? ''),
      module: str(e.module),
      handled: typeof mechanism.handled === 'boolean' ? mechanism.handled : undefined,
      mechanism: str(mechanism.type),
      synthetic: mechanism.synthetic === true || undefined,
      frames,
    }
  })
}

function threadsOf(threads: Json[], used: Set<Json>): Thread[] {
  const rank = (t: Json) => (t.crashed === true ? 2 : t.current === true ? 1 : 0)
  return [...threads]
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, MAX_THREADS)
    .map((t) => ({
      id: str(t.id),
      name: str(t.name) && cut(str(t.name)!, 200),
      crashed: t.crashed === true || undefined,
      current: t.current === true || undefined,
      frames: used.has(t) ? [] : framesOf(t.stacktrace).slice(-THREAD_FRAMES),
    }))
}

export const REQUEST_BODY = 8 * 1024
export const EXTRA = 16 * 1024

const pairsOf = (v: unknown): [string, unknown][] =>
  Array.isArray(v)
    ? v.filter((p) => Array.isArray(p) && typeof p[0] === 'string').map((p) => [p[0] as string, p[1]])
    : Object.entries(obj(v))

// Headers that carry the client's IP address: never kept, as crashyard stores no IPs. `request.env`, where SDKs put
// REMOTE_ADDR, isn't kept at all
const IP_HEADERS = new Set([
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-connecting-ipv6',
  'true-client-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'fastly-client-ip',
  'forwarded',
  'x-original-forwarded-for',
])

function requestOf(raw: unknown, trimmed: string[]): RequestInfo | undefined {
  const r = obj(raw)
  // Headers and query keys that name a secret are filtered, as in contexts; the rest is masked as tags are
  const kept = pairsOf(r.headers).filter(([k]) => !IP_HEADERS.has(k.toLowerCase()))
  const headers = Object.entries(obj(scrub(Object.fromEntries(kept.slice(0, 100)))))
    .map(([k, v]): [string, string] => [cut(k, 200), cut(str(v) ?? '', 2000)])
    .filter(([, v]) => v)
  const query = queryOf(
    typeof r.query_string === 'string' ? [...new URLSearchParams(r.query_string)] : pairsOf(r.query_string),
  )
  const [path, search] = (str(r.url) ?? '').split(/\?(.*)/s)
  const data = r.data
  let body =
    typeof data === 'string' ? scrubText(data) : data && typeof data === 'object' ? JSON.stringify(scrub(data)) : ''
  if (body.length > REQUEST_BODY) {
    body = cut(body, REQUEST_BODY)
    trimmed.push('request body')
  }
  const request: RequestInfo = {
    method: str(r.method)?.toUpperCase().slice(0, 16),
    url: path
      ? cut(scrubText(search ? `${path}?${queryOf([...new URLSearchParams(search)])}` : path), 2000)
      : undefined,
    query: query ? cut(query, 2000) : undefined,
    headers: headers.length ? headers : undefined,
    body: body || undefined,
  }
  return Object.values(request).some((v) => v !== undefined) ? request : undefined
}

/** A query string with the values of secret-looking keys filtered and the rest masked */
const queryOf = (pairs: [string, unknown][]) =>
  new URLSearchParams(
    pairs.slice(0, 100).map(([k, v]): [string, string] => [k, str(obj(scrub({ [k]: str(v) ?? '' }))[k]) ?? '']),
  )
    .toString()
    .replace(/%5BFiltered%5D/g, '[Filtered]')

/** The extra data, scrubbed, its keys in order while they fit in 16 KB of JSON */
function extraOf(raw: unknown, trimmed: string[]): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {}
  let size = 2
  for (const [key, value] of Object.entries(obj(scrub(obj(raw))))) {
    const n = JSON.stringify(key).length + (JSON.stringify(value)?.length ?? 4) + 2
    if (size + n > EXTRA) {
      trimmed.push('extra')
      break
    }
    extra[key] = value
    size += n
  }
  return Object.keys(extra).length ? extra : undefined
}

function messageOf(event: Json): string {
  const entry = obj(event.logentry)
  const message = event.message
  return scrubText(
    str(entry.formatted) ??
      str(entry.message) ??
      str(message) ??
      str(obj(message).formatted) ??
      str(obj(message).message) ??
      '',
  )
}

/** The function (or file) where it happened: the last frame in the app's own code */
export function culpritOf(frames: Frame[]): string | undefined {
  const inApp = frames.filter((f) => f.inApp)
  const frame = (inApp.length ? inApp : frames).at(-1)
  if (!frame) return undefined
  if (frame.function) return frame.module ? `${frame.module} in ${frame.function}` : frame.function
  return frame.filename ?? frame.absPath ?? (frame.package ? frame.package.split('/').at(-1) : undefined)
}

function tagsOf(event: Json): Record<string, string> {
  const tags: Record<string, string> = {}
  const raw = event.tags
  const pairs: [unknown, unknown][] = Array.isArray(raw)
    ? raw.filter(Array.isArray).map((p) => [p[0], p[1]] as [unknown, unknown])
    : Object.entries(obj(raw))
  for (const [k, v] of pairs) {
    const key = str(k)
    const value = str(v)
    if (key && value) tags[cut(key, 64)] = cut(scrubText(value), 200)
  }
  return tags
}

async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
}

export async function normalizeEvent(
  raw: unknown,
  received = Date.now(),
  fallbackId?: string,
): Promise<NormalizedEvent> {
  const event = obj(raw)
  const contexts = obj(scrub(obj(event.contexts)))
  const rawThreads = arr(event.threads).map(obj)
  const used = new Set<Json>()
  const exceptions = exceptionsOf(event, rawThreads, used)
  const threads = threadsOf(rawThreads, used)
  const main = exceptions.at(-1)
  const message = messageOf(event)
  const rawLevel = (str(event.level) ?? 'error').toLowerCase()
  const level = LEVELS.has(rawLevel) ? rawLevel : (LEVEL_ALIASES[rawLevel] ?? 'error')
  const transaction = str(event.transaction)
  // A synthetic exception is titled by its message alone, as Sentry does
  const title = main
    ? cut(
        main.synthetic && main.value
          ? main.value.split('\n')[0]
          : main.value
            ? `${main.type}: ${main.value.split('\n')[0]}`
            : main.type,
        200,
      )
    : cut(message.split('\n')[0] || transaction || '<unlabeled event>', 200)
  const culprit = cut((main && culpritOf(main.frames)) ?? transaction ?? '', 200)

  // Tags: the SDK's, then those Sentry derives from the event, which win
  const tags = tagsOf(event)
  const os = obj(contexts.os)
  const device = obj(contexts.device)
  const browser = obj(contexts.browser)
  const runtime = obj(contexts.runtime)
  const derived: Record<string, string | undefined> = {
    level,
    release: str(event.release),
    dist: str(event.dist),
    environment: str(event.environment),
    transaction,
    'os.name': str(os.name),
    os: str(os.name) && [str(os.name), str(os.version)].filter(Boolean).join(' '),
    device: str(device.model),
    'device.family': str(device.family),
    browser: str(browser.name) && [str(browser.name), str(browser.version)].filter(Boolean).join(' '),
    'browser.name': str(browser.name),
    runtime: str(runtime.name) && [str(runtime.name), str(runtime.version)].filter(Boolean).join(' '),
    handled: main?.handled === undefined ? undefined : main.handled ? 'yes' : 'no',
    mechanism: main?.mechanism,
  }
  for (const [k, v] of Object.entries(derived)) if (v) tags[k] = cut(v, 200)
  delete tags['user.id'] // users are counted by hash, never stored

  const user = obj(event.user)
  const userKey = str(user.id) ?? str(user.email) ?? str(user.username)
  const url = str(obj(event.request).url)
  const trimmed: string[] = []
  const request = requestOf(event.request, trimmed)
  const extra = extraOf(event.extra, trimmed)

  return {
    id: eventIdOf(event.event_id) ?? fallbackId ?? crypto.randomUUID().replace(/-/g, ''),
    timestamp: timestampOf(event.timestamp) ?? received,
    received,
    level,
    platform: str(event.platform) ?? 'other',
    release: str(event.release),
    environment: str(event.environment),
    dist: str(event.dist),
    type: main && !main.synthetic ? 'error' : 'message',
    title,
    culprit,
    message,
    exceptions,
    threads: threads.length ? threads : undefined,
    tags,
    contexts,
    breadcrumbs: arr(event.breadcrumbs)
      .slice(-100)
      .map((b) => {
        const c = obj(scrub(b))
        return {
          timestamp: timestampOf(c.timestamp),
          category: str(c.category),
          message: str(c.message),
          level: str(c.level),
          type: str(c.type),
          data: c.data,
        }
      }),
    userHash: userKey ? await hash(userKey) : undefined,
    fingerprint: arr(event.fingerprint)
      .map(str)
      .filter((s): s is string => !!s),
    transaction,
    request,
    extra,
    _trimmed: trimmed.length ? trimmed : undefined,
    traceId: str(obj(contexts.trace).trace_id),
    url: url?.split('?')[0],
    sdk: str(obj(event.sdk).name)
      ? { name: str(obj(event.sdk).name), version: str(obj(event.sdk).version) }
      : undefined,
    debugImages: arr(obj(event.debug_meta).images).map((raw) => {
      const i = obj(raw)
      return {
        type: str(i.type) ?? 'unknown',
        debugId: str(i.debug_id) ?? str(i.uuid),
        codeFile: str(i.code_file) ?? str(i.name),
        imageAddr: str(i.image_addr),
        imageSize: num(i.image_size),
      }
    }),
  }
}
