// A project's grouping rules, in the subset of Sentry's syntax its docs name ("Fingerprint Rules", "Stack Trace
// Rules"): one rule a line, `#` for a comment.
//
// - A fingerprint rule: matchers, `->`, then the fingerprint, values and variables split by commas or spaces:
//   `error.type:TimeoutError -> timeouts`, `message:"*connection reset*" -> net, {{ transaction }}`.
// - A stack trace rule: matchers, then actions: `stack.module:Vendor* -app`, `stack.function:log* -group`, each
//   action with `^` (the frames above, nearer the crash) or `v` (below) before it to apply there instead.
// - Matchers: error.type (type), error.value (value), message, level, tags.<name>, and of a frame stack.function
//   (function), stack.module (module), stack.abs_path (path), stack.package (package), app (yes or no) and family
//   (javascript, native, other or all, comma-separated). `!` before one negates it. Frame matchers of one rule must all
//   match the same frame.
// - Globs: `*` and `?`, `[…]`, `\` escapes. A path's (abs_path, package) `*` stops at a slash and `**` doesn't, and a
//   relative path still matches a leading `**/`. Case: error.value, message, level and paths ignore it; the rest don't.
import { culpritOf, type ExceptionValue, type Frame, type NormalizedEvent } from './event'

type Matcher = { key: string; negate: boolean; test: (value: string | undefined) => boolean }
export type Rule =
  | { kind: 'fingerprint'; matchers: Matcher[]; fingerprint: string[] }
  | { kind: 'stack'; matchers: Matcher[]; actions: Action[] }
type Action = { flag: 'app' | 'group'; on: boolean; range: 'self' | 'up' | 'down' }
export type Rules = { fingerprint: Rule[]; stack: Rule[] }
export type RulesError = { error: string; line: number }

const ALIASES: Record<string, string> = {
  type: 'error.type',
  value: 'error.value',
  function: 'stack.function',
  module: 'stack.module',
  path: 'stack.abs_path',
  package: 'stack.package',
}
const EVENT_KEYS = new Set(['error.type', 'error.value', 'message', 'level'])
const FRAME_KEYS = new Set(['stack.function', 'stack.module', 'stack.abs_path', 'stack.package', 'app', 'family'])
const PATHS = new Set(['stack.abs_path', 'stack.package'])
const CASELESS = new Set(['error.value', 'message', 'level', 'stack.abs_path', 'stack.package'])
const FAMILIES = new Set(['javascript', 'native', 'other', 'all'])
const VARIABLES = new Set([
  'default',
  'error.type',
  'type',
  'error.value',
  'value',
  'message',
  'level',
  'transaction',
  'stack.function',
  'function',
  'stack.module',
  'module',
  'stack.abs_path',
  'path',
  'stack.filename',
  'stack.package',
  'package',
])

// A glob as a regular expression: `*` any run, `?` one character, `[…]` and `[!…]` a class, `\` a literal. For a
// path, `*` and `?` stop at `/`, `**` doesn't, and a leading `**/` also matches no folder. `braces`: `{a,b}` is
// either, as in Relay's patterns
export function globToRegExp(glob: string, opts: { path?: boolean; caseless?: boolean; braces?: boolean } = {}) {
  let out = ''
  let depth = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '\\' && i + 1 < glob.length) out += escape(glob[++i])
    else if (c === '*' && glob[i + 1] === '*') {
      i++
      if (opts.path && glob[i + 1] === '/' && (i === 1 || glob[i - 2] === '/')) {
        i++
        out += '(?:.*/)?'
      } else out += '.*'
    } else if (c === '*') out += opts.path ? '[^/]*' : '.*'
    else if (c === '?') out += opts.path ? '[^/]' : '.'
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2)
      if (end < 0) out += '\\['
      else {
        const body = glob.slice(i + 1, end)
        out += `[${body.startsWith('!') ? `^${body.slice(1).replace(/[\\\]]/g, '\\$&')}` : body.replace(/[\\\]]/g, '\\$&')}]`
        i = end
      }
    } else if (opts.braces && c === '{') {
      depth++
      out += '(?:'
    } else if (opts.braces && c === '}' && depth) {
      depth--
      out += ')'
    } else if (opts.braces && c === ',' && depth) out += '|'
    else out += escape(c)
  }
  if (depth) return new RegExp(`^${escape(glob)}$`, opts.caseless ? 'i' : '')
  return new RegExp(`^${out}$`, opts.caseless ? 'is' : 's')
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')

const NATIVE = new Set(['native', 'cocoa', 'c', 'cpp', 'objc', 'swift'])
export const familyOf = (platform: string) =>
  NATIVE.has(platform) ? 'native' : platform === 'javascript' || platform === 'node' ? 'javascript' : 'other'

function matcherOf(rawKey: string, value: string): Matcher | string {
  const negate = rawKey.startsWith('!')
  const key = ALIASES[rawKey.slice(negate ? 1 : 0)] ?? rawKey.slice(negate ? 1 : 0)
  if (!EVENT_KEYS.has(key) && !FRAME_KEYS.has(key) && !/^tags\.[\w.-]+$/.test(key))
    return `“${key}” isn’t a matcher crashyard knows. Try error.type, error.value, message, level, tags.<name>, stack.function, stack.module, stack.abs_path, stack.package, app or family.`
  if (key === 'app') {
    if (value !== 'yes' && value !== 'no') return 'app: is yes or no.'
    return { key, negate, test: (v) => v === value }
  }
  if (key === 'family') {
    const families = value.split(',')
    if (!families.every((f) => FAMILIES.has(f))) return 'family: is javascript, native, other or all.'
    return { key, negate, test: (v) => families.includes('all') || families.includes(v ?? '') }
  }
  const re = globToRegExp(value, { path: PATHS.has(key), caseless: CASELESS.has(key) })
  return { key, negate, test: (v) => v !== undefined && re.test(v) }
}

/** A line's words: `key:value`, `key:"quoted value"`, `"quoted"`, or a bare word */
function wordsOf(line: string): string[] | string {
  const words: string[] = []
  let i = 0
  while (i < line.length) {
    if (/\s/.test(line[i])) {
      i++
      continue
    }
    let word = ''
    while (i < line.length && !/\s/.test(line[i])) {
      if (line[i] === '"') {
        const end = closingQuote(line, i)
        if (end < 0) return 'A quote isn’t closed. Close it, or put a \\ before it.'
        word += line.slice(i, end + 1)
        i = end + 1
      } else word += line[i++]
    }
    words.push(word)
  }
  return words
}
function closingQuote(line: string, from: number) {
  for (let i = from + 1; i < line.length; i++) {
    if (line[i] === '\\') i++
    else if (line[i] === '"') return i
  }
  return -1
}
const unquote = (s: string) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\"/g, '"') : s)

/** The fingerprint's values after `->`: commas or spaces between them, `{{ variable }}` kept as written */
function fingerprintOf(text: string): string[] | string {
  const parts = text.match(/\{\{\s*[\w.-]+\s*\}\}|"(?:[^"\\]|\\.)*"|[^\s,]+/g) ?? []
  const out: string[] = []
  for (const part of parts) {
    if (/^title=/.test(part)) return 'Custom titles aren’t supported. Remove title= from the rule.'
    const variable = part.match(/^\{\{\s*([\w.-]+)\s*\}\}$/)?.[1]
    if (variable && !VARIABLES.has(variable) && !/^tags\.[\w.-]+$/.test(variable))
      return `“{{ ${variable} }}” isn’t a value crashyard fills in. Try {{ default }}, {{ error.type }}, {{ error.value }}, {{ message }}, {{ transaction }} or {{ tags.<name> }}.`
    out.push(variable ? `{{ ${variable} }}` : unquote(part))
  }
  return out
}

const ACTION = /^([\^v]?)([+-])(app|group)$/

/** The rules in `text`, or the first line that isn't one and why */
export function parseGroupingRules(text: string): Rules | RulesError {
  const rules: Rules = { fingerprint: [], stack: [] }
  const lines = text.split('\n')
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim()
    if (!line || line.startsWith('#')) continue
    const fail = (error: string): RulesError => ({ error, line: n + 1 })
    const arrow = line.indexOf('->')
    const left = arrow >= 0 ? line.slice(0, arrow) : line
    const words = wordsOf(left)
    if (typeof words === 'string') return fail(words)
    const matchers: Matcher[] = []
    const actions: Action[] = []
    for (const word of words) {
      const action = word.match(ACTION)
      if (action && arrow < 0) {
        actions.push({ flag: action[3] as Action['flag'], on: action[2] === '+', range: rangeOf(action[1]) })
        continue
      }
      if (actions.length) return fail('Matchers come first, then the actions. Move the actions to the end of the rule.')
      const colon = word.indexOf(':')
      if (colon <= 0) {
        if (/^[\^v]?[+-]\w+$/.test(word) || /=/.test(word))
          return fail(
            `“${word}” isn’t an action crashyard knows. Use +app, -app, +group or -group, with ^ or v before one for the frames above or below.`,
          )
        return fail(`“${word}” isn’t a matcher. Write one as key:value, such as error.type:TimeoutError.`)
      }
      const value = unquote(word.slice(colon + 1))
      if (!value) return fail(`“${word}” needs a value after the colon.`)
      const matcher = matcherOf(word.slice(0, colon), value)
      if (typeof matcher === 'string') return fail(matcher)
      matchers.push(matcher)
    }
    if (!matchers.length) return fail('A rule starts with a matcher, such as error.type:TimeoutError.')
    if (arrow >= 0) {
      const fingerprint = fingerprintOf(line.slice(arrow + 2))
      if (typeof fingerprint === 'string') return fail(fingerprint)
      if (!fingerprint.length) return fail('Add a fingerprint after the arrow, such as -> timeouts.')
      rules.fingerprint.push({ kind: 'fingerprint', matchers, fingerprint })
    } else {
      if (!actions.length)
        return fail('End the rule with -> and a fingerprint, or with an action such as -app or -group.')
      if (matchers.some((m) => !FRAME_KEYS.has(m.key)))
        return fail(
          'A stack trace rule matches frames only: stack.function, stack.module, stack.abs_path, stack.package, app and family.',
        )
      rules.stack.push({ kind: 'stack', matchers, actions })
    }
  }
  return rules
}
const rangeOf = (c: string): Action['range'] => (c === '^' ? 'up' : c === 'v' ? 'down' : 'self')

type Ctx = { event: NormalizedEvent; family: string }

function frameValue(key: string, frame: Frame, ctx: Ctx): string | undefined {
  if (key === 'stack.function') return frame.function
  if (key === 'stack.module') return frame.module
  if (key === 'stack.package') return frame.package?.replace(/\\/g, '/')
  if (key === 'app') return frame.inApp ? 'yes' : 'no'
  if (key === 'family') return ctx.family
  return undefined
}

function frameMatches(matchers: Matcher[], frame: Frame, ctx: Ctx) {
  return matchers.every((m) => {
    if (m.key === 'stack.abs_path') {
      // Either path the SDK sent, as Sentry
      const paths = [frame.absPath, frame.filename].filter(Boolean).map((p) => p!.replace(/\\/g, '/'))
      const hit = paths.some((p) => m.test(p))
      return m.negate ? !hit : hit
    }
    const hit = m.test(frameValue(m.key, frame, ctx))
    return m.negate ? !hit : hit
  })
}

function eventMatches(m: Matcher, ctx: Ctx) {
  const e = ctx.event
  const values =
    m.key === 'error.type'
      ? e.exceptions.filter((x) => !x.synthetic).map((x) => x.type)
      : m.key === 'error.value'
        ? e.exceptions.map((x) => x.value)
        : m.key === 'message'
          ? [e.message, ...e.exceptions.map((x) => x.value)]
          : m.key === 'level'
            ? [e.level]
            : [e.tags[m.key.slice(5)]]
  const hit = values.some((v) => m.test(v))
  return m.negate ? !hit : hit
}

function ruleMatches(rule: Rule, ctx: Ctx) {
  const frameMatchers = rule.matchers.filter((m) => FRAME_KEYS.has(m.key))
  if (!rule.matchers.filter((m) => !FRAME_KEYS.has(m.key)).every((m) => eventMatches(m, ctx))) return false
  if (!frameMatchers.length) return true
  return ctx.event.exceptions.some((x) => x.frames.some((f) => frameMatches(frameMatchers, f, ctx)))
}

/** The frame a fingerprint's `{{ stack.* }}` reads: the app's frame nearest the crash, else the crash's */
function crashingFrame(e: NormalizedEvent): Frame | undefined {
  const frames = e.exceptions.at(-1)?.frames ?? []
  return frames.findLast((f) => f.inApp) ?? frames.at(-1)
}

function fill(part: string, e: NormalizedEvent): string {
  const variable = part.match(/^\{\{ ([\w.-]+) \}\}$/)?.[1]
  if (!variable || variable === 'default') return part
  const main = e.exceptions.at(-1)
  const frame = crashingFrame(e)
  const key = ALIASES[variable] ?? variable
  if (key.startsWith('tags.')) return e.tags[key.slice(5)] ?? ''
  const values: Record<string, string | undefined> = {
    'error.type': main?.type,
    'error.value': main?.value,
    message: e.message,
    level: e.level,
    transaction: e.transaction,
    'stack.function': frame?.function,
    'stack.module': frame?.module,
    'stack.abs_path': frame?.absPath ?? frame?.filename,
    'stack.filename': frame?.filename,
    'stack.package': frame?.package,
  }
  return values[key] ?? ''
}

/**
 * Applies the rules: stack trace rules set each frame's in-app flag on the event itself, as Sentry shows it, and so its
 * culprit, and take frames out of grouping; the first fingerprint rule that matches sets the fingerprint, over the
 * SDK's. Answers the event as grouping sees it
 */
export function applyRules(event: NormalizedEvent, rules: Rules): NormalizedEvent {
  if (!rules.stack.length && !rules.fingerprint.length) return event
  const ctx: Ctx = { event, family: familyOf(event.platform) }
  const grouped = new Set<Frame>()
  for (const exception of event.exceptions) {
    for (const f of exception.frames) grouped.add(f)
    for (const rule of rules.stack) {
      if (rule.kind !== 'stack') continue
      exception.frames.forEach((frame, i) => {
        if (!frameMatches(rule.matchers, frame, ctx)) return
        for (const a of rule.actions) {
          const targets =
            a.range === 'self'
              ? [frame]
              : a.range === 'up'
                ? exception.frames.slice(i + 1)
                : exception.frames.slice(0, i)
          for (const t of targets) {
            if (a.flag === 'app') t.inApp = a.on
            else if (a.on) grouped.add(t)
            else grouped.delete(t)
          }
        }
      })
    }
  }
  // The culprit is the last in-app frame, as the rules left them (a security report's is its directive)
  const main = event.exceptions.at(-1)
  if (rules.stack.length && main && event.type !== 'csp')
    event.culprit = culpritOf(main.frames)?.slice(0, 200) ?? event.culprit
  const exceptions: ExceptionValue[] = event.exceptions.map((x) => ({
    ...x,
    frames: x.frames.filter((f) => grouped.has(f)),
  }))
  const view = { ...event, exceptions }
  const rule = rules.fingerprint.find((r) => ruleMatches(r, ctx))
  if (rule?.kind === 'fingerprint') view.fingerprint = rule.fingerprint.map((p) => fill(p, event))
  return view
}

// Parsed once per text, as every event of a project reads the same rules
const parsed = new Map<string, Rules>()
const NONE: Rules = { fingerprint: [], stack: [] }
/** A project's stored rules; ones that no longer parse (saved by a later version) apply as none */
export function rulesOf(text: string | null | undefined): Rules {
  if (!text?.trim()) return NONE
  let rules = parsed.get(text)
  if (!rules) {
    const result = parseGroupingRules(text)
    rules = 'error' in result ? NONE : result
    if (parsed.size > 100) parsed.clear()
    parsed.set(text, rules)
  }
  return rules
}
