// A project's grouping rules, in the subset of Sentry's syntax its docs name ("Fingerprint Rules", "Stack Trace
// Rules"): one rule a line, `#` for a comment.
//
// - A fingerprint rule: matchers, `->`, then the fingerprint, values and variables split by commas or spaces:
//   `error.type:TimeoutError -> timeouts`, `message:"*connection reset*" -> net, {{ transaction }}`.
// - A stack trace rule: matchers, then actions: `stack.module:Vendor* -app`, `stack.function:log* -group`, each
//   action with `^` (the frames above, nearer the crash) or `v` (below) before it to apply there instead.
// - Matchers: error.type (type), error.value (value), message, level, tags.<name>, and of a frame stack.function
//   (function), stack.module (module), stack.abs_path (path), stack.package (package), app (yes or no), family
//   (javascript, native, other or all, comma-separated) and category. `!` before one negates it. Frame matchers of one
//   rule must all match the same frame; `[ matcher ] |` matches the frame before it (its caller), `| [ matcher ]` the
//   one after (its callee).
// - Actions also `category=<name>`, which names the frame for later rules' `category:`. `#` starts a comment, also
//   after a rule.
// - Globs: `*` and `?`, `[…]`, `\` escapes. A path's (abs_path, package) `*` stops at a slash and `**` doesn't, and a
//   relative path still matches a leading `**/`. Case: error.value, message, level and paths ignore it; the rest don't.
import { culpritOf, type ExceptionValue, type Frame, type NormalizedEvent } from './event'
import { behaviourOf, trimFunction } from './functions'

type Matcher = {
  key: string
  negate: boolean
  test: (value: string | undefined) => boolean
  sibling?: 'caller' | 'callee' // matches the frame before (`[ m ] |`) or after (`| [ m ]`) instead
}
export type Rule =
  | { kind: 'fingerprint'; matchers: Matcher[]; fingerprint: string[] }
  | { kind: 'stack'; matchers: Matcher[]; actions: Action[] }
type Action =
  { flag: 'app' | 'group'; on: boolean; range: 'self' | 'up' | 'down' } | { flag: 'category'; value: string }
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
const FRAME_KEYS = new Set([
  'stack.function',
  'stack.module',
  'stack.abs_path',
  'stack.package',
  'app',
  'family',
  'category',
])
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
    return `“${key}” isn’t a matcher crashyard knows. Try error.type, error.value, message, level, tags.<name>, stack.function, stack.module, stack.abs_path, stack.package, app, family or category.`
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
// A quoted value's `\"` is a quote. With `escapes`, as Sentry reads its own rules, `\\` is a backslash too; a
// project's rules keep it as written, as they always have
const unquote = (s: string, escapes = false) =>
  s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(escapes ? /\\(["\\])/g : /\\(")/g, '$1') : s

/** The fingerprint's values after `->`: commas or spaces between them, `{{ variable }}` kept as written */
function fingerprintOf(text: string, escapes: boolean): string[] | string {
  const parts = text.match(/\{\{\s*[\w.-]+\s*\}\}|"(?:[^"\\]|\\.)*"|[^\s,]+/g) ?? []
  const out: string[] = []
  for (const part of parts) {
    if (/^title=/.test(part)) return 'Custom titles aren’t supported. Remove title= from the rule.'
    const variable = part.match(/^\{\{\s*([\w.-]+)\s*\}\}$/)?.[1]
    if (variable && !VARIABLES.has(variable) && !/^tags\.[\w.-]+$/.test(variable))
      return `“{{ ${variable} }}” isn’t a value crashyard fills in. Try {{ default }}, {{ error.type }}, {{ error.value }}, {{ message }}, {{ transaction }} or {{ tags.<name> }}.`
    out.push(variable ? `{{ ${variable} }}` : unquote(part, escapes))
  }
  return out
}

const ACTION = /^([\^v]?)([+-])(app|group)$/
const CATEGORY = /^category=([\w.-]+)$/

/** Where a comment starts: a `#` outside quotes, after a space; -1 for none */
function commentAt(line: string) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      const end = closingQuote(line, i)
      if (end < 0) return -1
      i = end
    } else if (line[i] === '#' && /\s/.test(line[i - 1] ?? '')) return i
  }
  return -1
}

/**
 * The rules in `text`, or the first line that isn't one and why. `escapes`: quoted values read `\\` as Sentry reads
 * its built-in rules
 */
export function parseGroupingRules(text: string, { escapes = false } = {}): Rules | RulesError {
  const rules: Rules = { fingerprint: [], stack: [] }
  const lines = text.split('\n')
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n].trim()
    if (!line || line.startsWith('#')) continue
    const fail = (error: string): RulesError => ({ error, line: n + 1 })
    // A comment may follow a rule's matchers and actions. After a fingerprint's arrow a `#` stays a value, as before
    const hash = commentAt(line)
    if (hash >= 0 && (line.indexOf('->') < 0 || hash < line.indexOf('->'))) line = line.slice(0, hash).trim()
    const arrow = line.indexOf('->')
    const left = arrow >= 0 ? line.slice(0, arrow) : line
    const all = wordsOf(left)
    if (typeof all === 'string') return fail(all)
    // `[m]|` and `|[m]` are `[ m ] |` and `| [ m ]`: a matcher never starts with a bracket or a bar
    const words = all.flatMap((w) =>
      /^(\|?\[)(.+)(\]\|?)$/.test(w) ? [...w.match(/^(\|?)(\[)(.+)(\])(\|?)$/)!.slice(1)].filter(Boolean) : [w],
    )
    const matchers: Matcher[] = []
    const actions: Action[] = []
    for (let w = 0; w < words.length; w++) {
      let word = words[w]
      const action = word.match(ACTION)
      if (action && arrow < 0) {
        actions.push({ flag: action[3] as 'app' | 'group', on: action[2] === '+', range: rangeOf(action[1]) })
        continue
      }
      const category = word.match(CATEGORY)
      if (category && arrow < 0) {
        actions.push({ flag: 'category', value: category[1] })
        continue
      }
      // A sibling frame's matcher: `[ m ] |` (the caller) or `| [ m ]` (the callee)
      let sibling: Matcher['sibling']
      if (word === '[' || word === '|') {
        const caller = word === '['
        const [a, b, c] = words.slice(w + 1, w + 4)
        if (caller ? b !== ']' || c !== '|' : a !== '[' || c !== ']')
          return fail('A frame before or after is written [ matcher ] | or | [ matcher ], with one matcher.')
        sibling = caller ? 'caller' : 'callee'
        word = (caller ? a : b) ?? ''
        w += 3
      }
      if (actions.length) return fail('Matchers come first, then the actions. Move the actions to the end of the rule.')
      const colon = word.indexOf(':')
      if (colon <= 0) {
        if (/^[\^v]?[+-]\w+$/.test(word) || /=/.test(word))
          return fail(
            `“${word}” isn’t an action crashyard knows. Use +app, -app, +group or -group, with ^ or v before one for the frames above or below, or category=<name>.`,
          )
        return fail(`“${word}” isn’t a matcher. Write one as key:value, such as error.type:TimeoutError.`)
      }
      const value = unquote(word.slice(colon + 1), escapes)
      if (!value) return fail(`“${word}” needs a value after the colon.`)
      const matcher = matcherOf(word.slice(0, colon), value)
      if (typeof matcher === 'string') return fail(matcher)
      if (sibling && !FRAME_KEYS.has(matcher.key))
        return fail('A frame before or after matches frames only, such as [ stack.function:main ] |.')
      matchers.push(sibling ? { ...matcher, sibling } : matcher)
    }
    if (!matchers.length) return fail('A rule starts with a matcher, such as error.type:TimeoutError.')
    if (arrow >= 0) {
      const fingerprint = fingerprintOf(line.slice(arrow + 2), escapes)
      if (typeof fingerprint === 'string') return fail(fingerprint)
      if (!fingerprint.length) return fail('Add a fingerprint after the arrow, such as -> timeouts.')
      rules.fingerprint.push({ kind: 'fingerprint', matchers, fingerprint })
    } else {
      if (!actions.length)
        return fail('End the rule with -> and a fingerprint, or with an action such as -app or -group.')
      if (matchers.some((m) => !FRAME_KEYS.has(m.key)))
        return fail(
          'A stack trace rule matches frames only: stack.function, stack.module, stack.abs_path, stack.package, app, family and category.',
        )
      rules.stack.push({ kind: 'stack', matchers, actions })
    }
  }
  return rules
}
const rangeOf = (c: string): 'self' | 'up' | 'down' => (c === '^' ? 'up' : c === 'v' ? 'down' : 'self')

/** `trimmed`: function matchers read Sentry's trimmed names, `<unknown>` for none, as grouping v2 does; v1 the raw */
type Ctx = { event: NormalizedEvent; family: string; trimmed?: boolean }
/** A frame's in-app flag and category as the rules leave them, and `group` if a rule said whether it groups */
export type FrameState = { inApp: boolean; category?: string; group?: boolean }
type StateOf = (i: number) => FrameState

// Each frame's trimmed function, as every rule reads it again
const trimmed = new WeakMap<Frame, string>()
function trimmedOf(frame: Frame, platform: string) {
  let name = trimmed.get(frame)
  if (name === undefined) {
    name = frame.function ? trimFunction(frame.function, frame.platform ?? platform) : '<unknown>'
    trimmed.set(frame, name)
  }
  return name
}

function frameValue(key: string, frame: Frame, state: FrameState, ctx: Ctx): string | undefined {
  if (key === 'stack.function') return ctx.trimmed ? trimmedOf(frame, ctx.event.platform) : frame.function
  if (key === 'stack.module') return frame.module
  if (key === 'stack.package') return frame.package?.replace(/\\/g, '/')
  if (key === 'app') return state.inApp ? 'yes' : 'no'
  if (key === 'family') return frame.platform && ctx.trimmed ? behaviourOf(frame.platform) : ctx.family
  if (key === 'category') return state.category
  return undefined
}

/** Whether frame `i` matches all `matchers`; a sibling's matcher reads the frame before or after, none past the ends */
function frameMatches(matchers: Matcher[], frames: Frame[], i: number, state: StateOf, ctx: Ctx) {
  return matchers.every((m) => {
    const at = m.sibling === 'caller' ? i - 1 : m.sibling === 'callee' ? i + 1 : i
    if (at < 0 || at >= frames.length) return false
    const frame = frames[at]
    let hit: boolean
    if (m.key === 'stack.abs_path') {
      // Version 1: either path the SDK sent. Version 2 as Sentry's enhancer: the abs_path, else the filename, a
      // relative one also with a leading slash
      const paths = ctx.trimmed
        ? [frame.absPath || frame.filename].filter(Boolean).flatMap((p) => (p!.startsWith('/') ? [p!] : [p!, `/${p}`]))
        : [frame.absPath, frame.filename].filter(Boolean)
      hit = paths.some((p) => m.test(p!.replace(/\\/g, '/')))
    } else hit = m.test(frameValue(m.key, frame, state(at), ctx))
    return m.negate ? !hit : hit
  })
}

// In version 2 the transaction is a tag, as in Sentry, so Sentry's own rules read it
const tagOf = (e: NormalizedEvent, key: string, sentry: boolean) =>
  e.tags[key] ?? (sentry && key === 'transaction' ? e.transaction : undefined)

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
            : [tagOf(e, m.key.slice(5), !!ctx.trimmed)]
  const hit = values.some((v) => m.test(v))
  return m.negate ? !hit : hit
}

function ruleMatches(rule: Rule, ctx: Ctx) {
  // In version 2 a fingerprint rule's family is the event's, as in Sentry, needing no frame. Version 1 reads it on a
  // frame, as it always has
  const eventFamily = !!ctx.trimmed
  const family = eventFamily ? rule.matchers.filter((m) => m.key === 'family') : []
  if (!family.every((m) => m.test(ctx.family) !== m.negate)) return false
  const frameMatchers = rule.matchers.filter((m) => FRAME_KEYS.has(m.key) && !(eventFamily && m.key === 'family'))
  if (!rule.matchers.filter((m) => !FRAME_KEYS.has(m.key)).every((m) => eventMatches(m, ctx))) return false
  if (!frameMatchers.length) return true
  return ctx.event.exceptions.some((x) =>
    x.frames.some((_, i) => frameMatches(frameMatchers, x.frames, i, (j) => ({ inApp: x.frames[j].inApp }), ctx)),
  )
}

/** The frame a fingerprint's `{{ stack.* }}` reads: the app's frame nearest the crash, else the crash's */
function crashingFrame(e: NormalizedEvent): Frame | undefined {
  const frames = e.exceptions.at(-1)?.frames ?? []
  return frames.findLast((f) => f.inApp) ?? frames.at(-1)
}

function fill(part: string, e: NormalizedEvent, sentry = false): string {
  const variable = part.match(/^\{\{ ([\w.-]+) \}\}$/)?.[1]
  if (!variable || variable === 'default') return part
  const main = e.exceptions.at(-1)
  const frame = crashingFrame(e)
  const key = ALIASES[variable] ?? variable
  if (key.startsWith('tags.')) return tagOf(e, key.slice(5), sentry) ?? ''
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
    const frames = exception.frames
    for (const f of frames) grouped.add(f)
    for (const rule of rules.stack) {
      if (rule.kind !== 'stack') continue
      frames.forEach((frame, i) => {
        if (!frameMatches(rule.matchers, frames, i, (j) => ({ inApp: frames[j].inApp }), ctx)) return
        for (const a of rule.actions) {
          if (a.flag === 'category') continue // grouping v1 has no categories
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

/**
 * Grouping v2's stack rules over one stack, in Sentry's two passes: the in-app flags and categories, rule by rule
 * (a rule finds its frames before it acts on them), then, on what that left, which frames group. Starts from the
 * SDK's in-app flags (`origInApp`, where a rule changed one before). Changes nothing
 */
export function stackStates(event: NormalizedEvent, frames: Frame[], rules: Rule[]): FrameState[] {
  const ctx: Ctx = { event, family: behaviourOf(event.platform), trimmed: true }
  const states: FrameState[] = frames.map((f) => ({ inApp: f.origInApp ?? f.inApp }))
  const state = (i: number) => states[i]
  for (const grouping of [false, true]) {
    for (const rule of rules) {
      if (rule.kind !== 'stack') continue
      const actions = rule.actions.filter((a) => (a.flag === 'group') === grouping)
      if (!actions.length) continue
      const hits = frames.flatMap((_, i) => (frameMatches(rule.matchers, frames, i, state, ctx) ? [i] : []))
      for (const i of hits)
        for (const a of actions) {
          if (a.flag === 'category') {
            states[i].category = a.value
            continue
          }
          const [from, to] = a.range === 'self' ? [i, i + 1] : a.range === 'up' ? [i + 1, frames.length] : [0, i]
          for (let j = from; j < to; j++)
            if (a.flag === 'app') states[j].inApp = a.on
            else states[j].group = a.on
        }
    }
  }
  return states
}

/**
 * Shows the in-app flags `states` (one list an exception, of its innermost frames) on the event itself, as Sentry
 * does, the SDK's own kept in `origInApp` where they differ, and takes the culprit again from them
 */
export function setInApp(event: NormalizedEvent, states: FrameState[][]) {
  event.exceptions.forEach((x, e) =>
    // The states are of the innermost frames: the ones before keep the SDK's flags
    x.frames.slice(x.frames.length - states[e].length).forEach((f, i) => {
      const sdk = f.origInApp ?? f.inApp
      f.inApp = states[e][i].inApp
      if (f.inApp !== sdk) f.origInApp = sdk
      else delete f.origInApp
    }),
  )
  const main = event.exceptions.at(-1)
  if (main && event.type !== 'csp') event.culprit = culpritOf(main.frames)?.slice(0, 200) ?? event.culprit
}

/** The first fingerprint rule of `rules` that matches, its values filled in */
export function fingerprintRule(event: NormalizedEvent, rules: Rule[]): string[] | undefined {
  const ctx: Ctx = { event, family: behaviourOf(event.platform), trimmed: true }
  const rule = rules.find((r) => ruleMatches(r, ctx))
  return rule?.kind === 'fingerprint' ? rule.fingerprint.map((p) => fill(p, event, true)) : undefined
}

// Parsed once per text, as every event of a project reads the same rules
const parsed = new Map<string, Rules>()
/** No rules: what a project without any has */
export const NO_RULES: Rules = { fingerprint: [], stack: [] }
const NONE = NO_RULES
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
