// Which issue an event belongs to: a hash of what stays the same each time the same thing goes wrong.
//
// - An exception with a stack: its type and the five frames nearest the crash in the app's own code (all frames when
//   the SDK marks none as the app's). A frame is its function, or for native code without symbols the image and the
//   offset in it, which is the same on every run of a build (the image's address isn't, under ASLR).
// - An exception without a stack: its type and value. A message: the message.
// - A frame with no name (`?`, `<anonymous>`) is its line of source, or its file and line. A synthetic exception (one an
//   SDK made to carry a stack, as captureMessage does) groups without its type.
// - Values and messages are compared with numbers, ids, hex, UUIDs and quoted text masked, so "id 42" and "id 43" are
//   one issue.
// - An SDK's own fingerprint wins; "{{ default }}" in it stands for the default above.
import { BUILTIN_FINGERPRINTS, BUILTIN_RULES } from './builtin-rules'
import type { ExceptionValue, Frame, NormalizedEvent } from './event'
import { behaviourOf, jsModule, trimFunction, withoutBundleHash } from './functions'
import { parameterize } from './parameterize'
import { applyRules, fingerprintRule, type FrameState, type Rules, setInApp, stackStates } from './rules'

const FRAMES = 5

export function mask(text: string): string {
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/(["'`])(?:(?!\1).){0,200}\1/g, '<string>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
}

function hexOffset(instruction?: string, image?: string): string | undefined {
  if (!instruction || !image) return undefined
  try {
    return `0x${(BigInt(instruction) - BigInt(image)).toString(16)}`
  } catch {
    return undefined
  }
}

// Names engines give functions that have none: grouping by them would make every anonymous frame the same
const ANONYMOUS = new Set(['?', '<anonymous>', 'anonymous', '<unknown>', 'Object.<anonymous>'])

export function frameKey(frame: Frame): string {
  if (frame.function && !ANONYMOUS.has(frame.function)) return [frame.module, frame.function].filter(Boolean).join('.')
  // An anonymous function: its line of source if the SDK sent it, as Sentry groups them
  if (frame.context?.line?.trim())
    return `${frame.module ?? frame.filename ?? ''}:${frame.context.line.trim().slice(0, 120)}`
  const offset = hexOffset(frame.instructionAddr, frame.imageAddr)
  const image = frame.package?.split('/').at(-1)
  if (image && offset) return `${image}+${offset}`
  return [frame.filename ?? frame.absPath, frame.lineno].filter(Boolean).join(':') || frame.instructionAddr || '?'
}

export function defaultComponents(event: NormalizedEvent): string[] {
  const main = event.exceptions.at(-1)
  if (main) {
    const inApp = main.frames.filter((f) => f.inApp)
    const frames = (inApp.length ? inApp : main.frames).slice(-FRAMES)
    // A synthetic exception's type is the SDK's, not the app's: leave it out
    if (frames.length) return [...(main.synthetic ? [] : [main.type]), ...frames.map(frameKey)]
    return [main.type, mask(main.value)]
  }
  return [mask(event.message || event.title)]
}

export async function fingerprintOf(event: NormalizedEvent): Promise<string> {
  const custom = event.fingerprint?.length ? event.fingerprint : undefined
  const components = custom
    ? custom.flatMap((part) => (/^\{\{\s*default\s*\}\}$/.test(part) ? defaultComponents(event) : [part]))
    : defaultComponents(event)
  return sha(components)
}

const sha = async (components: string[]) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(components.join('\n')))
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
}

// ---- Version 2: Sentry's grouping (newstyle:2023-01-11 of getsentry/sentry 24.10.0, `src/sentry/grouping/strategies/
// newstyle.py`, Apache-2.0 since 2026-10-15 under its FSL-1.1-Apache-2.0 license), with crashyard's differences, each
// marked "crashyard:". Ported in this file, `functions.ts`, `parameterize.ts`, `builtin-rules.ts` and `rules.ts`.

// A URL, where a filename or context line says little: `has_url_origin`
const urlOrigin = (path: string | undefined, allowFile: boolean) =>
  !!path && (/^(https?|applewebdata|blob):/.test(path) || (path.startsWith('file:') && !allowFile))
const CONTEXT_LINE_PLATFORMS = new Set(['javascript', 'node', 'python', 'php', 'ruby'])
const JS_ANONYMOUS = new Set(['?', '<anonymous function>', '<anonymous>', 'Anonymous function'])
const JS_LOW_QUALITY = new Set(['[native code]', 'native code', 'eval code', '<anonymous>'])
// Java's generated classes, numbered or hashed per run
const JAVA_CODEGEN = [
  /(sun\.reflect\.Generated(?:Serialization)?ConstructorAccessor)\d+/g,
  /(\$\$[\w_]+?CGLIB\$\$)[a-fA-F0-9]+(_[0-9]+)?/g,
  /(\$\$_javassist)(?:_seam)?(?:_[0-9]+)?/g,
  /(\$fn__)\d+/g,
  /(\$\$?EnhancerBy[\w_]+?\$?\$)[a-fA-F0-9]+(_[0-9]+)?/g,
  /(\$\$?FastClassBy[\w_]+?\$?\$)[a-fA-F0-9]+(_[0-9]+)?/g,
  /(\$\$?HibernateProxy\$?\$)\w+(_[0-9]+)?/g,
]
const JAVASSIST = /(\$\$_javassist)(?:_seam)?(?:_[0-9]+)?/g

function moduleOf(f: Frame, platform: string): string | undefined {
  let module = f.module
  // Sentry names a script's module after its URL as the event comes in (`generate_modules`); crashyard at grouping
  if (!module && behaviourOf(platform) === 'javascript' && /^(https?|webpack|app):/.test(f.absPath ?? ''))
    module = jsModule(f.absPath!)
  if (module === undefined) return undefined
  if (platform === 'javascript' && module.includes('/') && f.absPath?.endsWith(module)) return undefined
  if (platform === 'java') {
    if (module.includes('$$Lambda$')) return undefined
    if (module.startsWith('sun.reflect.GeneratedMethodAccessor')) return 'sun.reflect.GeneratedMethodAccessor'
    if (module.startsWith('jdk.internal.reflect.GeneratedMethodAccessor'))
      return 'jdk.internal.reflect.GeneratedMethodAccessor'
    for (const re of JAVA_CODEGEN) module = module.replace(re, '$1<auto>')
  }
  // crashyard: a bundle's content hash, without a source map to name the file
  return behaviourOf(platform) === 'javascript' && !f.symbolicated ? withoutBundleHash(module) : module
}

function filenameOf(f: Frame, platform: string): string | undefined {
  if (f.filename === undefined) return undefined
  // Sentry strips a browser script's query string, a cache-buster, before grouping
  let name = (platform === 'javascript' ? f.filename.split('?')[0] : f.filename).split(/[/\\]/).at(-1)!
  // crashyard: as for the module, before the case goes
  if (behaviourOf(platform) === 'javascript' && !f.symbolicated) name = withoutBundleHash(name)
  name = name.toLowerCase()
  if (urlOrigin(f.absPath, true) || name === '<anonymous>' || name === '[native code]') return undefined
  return platform === 'java' ? name.replace(JAVASSIST, '$1<auto>') : name
}

function contextLineOf(f: Frame, platform: string): string | undefined {
  const raw = f.context?.line
  if (!CONTEXT_LINE_PLATFORMS.has(platform) || raw === undefined) return undefined
  const line = raw.split(/\s+/).filter(Boolean).join(' ')
  if (!line || raw.length > 120) return undefined
  if (behaviourOf(platform) === 'javascript' && !f.function && urlOrigin(f.absPath, false)) return undefined
  return line
}

function functionOf(f: Frame, platform: string, contextLine: boolean): string | undefined {
  if (!f.function) return undefined
  // C# keeps its signature in grouping, as Sentry reads its raw name there
  let fn = trimFunction(f.function, platform)
  const family = behaviourOf(platform)
  if (platform === 'ruby') return fn.startsWith('block ') ? 'block' : fn.replace(/__\d{4,}_\d{4,}$/, '')
  if (platform === 'php') {
    if (fn.startsWith('[Anonymous') || fn.startsWith('class@anonymous\x00')) return undefined
    return fn.startsWith('class@anonymous') ? fn.split('::').at(-1) : fn
  }
  if (platform === 'java') return fn.startsWith('lambda$') ? undefined : fn
  if (family === 'native') return fn === '<redacted>' || fn === '<unknown>' ? undefined : fn
  if (family === 'javascript') {
    fn = fn.split('.').at(-1)!
    // A source-mapped function's name is unreliable where its line is known
    if ((f.symbolicated && contextLine) || !fn || JS_ANONYMOUS.has(fn) || fn.endsWith('/<')) return undefined
  }
  return fn
}

/** What a frame groups by, in Sentry's order: module or filename, function, context line; undefined for nothing */
function frameValues(f: Frame, inApp: boolean, platform: string): string[] | undefined {
  const family = behaviourOf(platform)
  if (family === 'javascript') {
    const fn = f.function?.split('.').at(-1)
    if (fn === 'eval' || JS_LOW_QUALITY.has(f.absPath ?? '')) return undefined
  }
  const module = moduleOf(f, platform)
  const filename = module === undefined ? filenameOf(f, platform) : undefined
  const line = contextLineOf(f, platform)
  const fn = functionOf(f, platform, line !== undefined)
  const values = [module, filename, fn, line].filter((v) => v !== undefined)
  // crashyard: an app's frame without symbols is its image and the offset in it, the same on every run of a build,
  // so it groups before its debug file arrives. Sentry leaves such a frame out, as crashyard does a system one
  if (!values.length && family === 'native' && inApp) {
    const offset = hexOffset(f.instructionAddr, f.imageAddr)
    const image = f.package?.split(/[/\\]/).at(-1)
    if (image && offset) return [`${image}+${offset}`]
  }
  return values.length ? values : undefined
}

// A frame equal to the one before is recursion, its function compared trimmed as Sentry stores it
const RECURSION: (keyof Frame)[] = ['absPath', 'package', 'module', 'filename', 'lineno', 'colno']
const recursive = (a: Frame, b: Frame, platform: string) =>
  RECURSION.every((k) => a[k] === b[k]) &&
  (a.function && b.function
    ? trimFunction(a.function, a.platform ?? platform) === trimFunction(b.function, b.platform ?? platform)
    : a.function === b.function)
const isUrl = (path: string | undefined) => !!path && /^(blob|file|https?|applewebdata):/.test(path)

/**
 * crashyard: grouping v2 reads the 250 frames nearest the crash, as Relay keeps 250 of a stack. Sentry's rules run over
 * every frame they read, some of them over every frame above or below a match, so a stack of thousands would cost
 * seconds; the rest keep the SDK's in-app flags
 */
export const GROUPING_FRAMES = 250
const groupingFrames = (x: ExceptionValue) => x.frames.slice(-GROUPING_FRAMES)

type Stacks = { app: string[][]; system: string[][] }
/** An exception's frames as each variant groups them, the nearest the crash last */
function stacksOf(x: ExceptionValue, states: FrameState[], platform: string): Stacks {
  const frames = groupingFrames(x)
  const values = frames.map((f, i) => {
    if (i > 0 && recursive(f, frames[i - 1], platform)) return undefined
    return frameValues(f, states[i].inApp, f.platform ?? platform)
  })
  // A lone JavaScript frame of a URL without a function says nothing (Sentry's 24.10.0 test, as it reads)
  const lone = frames[0]?.platform ?? platform
  if (frames.length === 1 && values[0] && behaviourOf(lone) === 'javascript' && !frames[0].function)
    if (isUrl(frames[0].absPath)) values[0] = undefined
  const pick = (app: boolean) =>
    values.filter((v, i) => v && states[i].group !== false && (!app || states[i].inApp)) as string[][]
  return { app: pick(true), system: pick(false) }
}

/** An exception's own parts after its stack: its type, an NSError's domain and code, and else its value */
function tailOf(x: ExceptionValue, stack: boolean): string[] {
  // crashyard: every app hang is one type, its duration aside: macOS sends "App Hanging", iOS "App Hang Fully
  // Blocked", "Non Fully Blocked" and "Fatal App Hang…"
  const hang = x.mechanism === 'AppHang'
  const out = x.synthetic ? [] : [hang ? 'App Hang' : x.type]
  const ns = x.nsError ? [x.nsError.domain, x.nsError.code].filter((v) => v !== undefined).map(String) : []
  out.push(...ns)
  if (!stack && !ns.length && !hang) {
    const value = parameterize(x.value)
    if (value) out.push(value)
  }
  return out
}

/**
 * The exceptions of a group that count (`filter_exceptions_for_exception_groups`). Malformed groups count whole, as
 * Sentry falls back to them when its filter fails
 */
function groupedExceptions(xs: ExceptionValue[], keyOf: (x: ExceptionValue) => string): ExceptionValue[] {
  try {
    return exceptionGroup(xs, keyOf)
  } catch {
    return xs
  }
}

function exceptionGroup(xs: ExceptionValue[], keyOf: (x: ExceptionValue) => string): ExceptionValue[] {
  if (xs.length <= 1 || xs.some((x) => x.exceptionId === undefined)) return xs
  const nodes = new Map<number, { exception?: ExceptionValue; children: ExceptionValue[] }>()
  const node = (id: number) => nodes.get(id) ?? nodes.set(id, { children: [] }).get(id)!
  for (const x of [...xs].reverse()) {
    node(x.exceptionId!).exception = x
    if (x.parentId !== undefined) node(x.parentId).children.push(x)
  }
  const root = nodes.get(0)?.exception
  if (!root) return xs
  const children = (x: ExceptionValue) => nodes.get(x.exceptionId!)?.children ?? []
  // The top-level exceptions: the first ones under the root that aren't groups themselves, depth first, in order.
  // Walked without recursion, each exception once, so a deep or cyclic group can't overflow the stack
  const top: ExceptionValue[] = []
  const seen = new Set<ExceptionValue>()
  for (const todo = [root]; todo.length;) {
    const x = todo.pop()!
    if (seen.has(x)) continue
    seen.add(x)
    if (x.isGroup) todo.push(...[...children(x)].reverse())
    else top.push(x)
  }
  top.sort((a, b) => (a.type < b.type ? 1 : a.type > b.type ? -1 : 0))
  const distinct = top.filter((x, i) => i === 0 || keyOf(x) !== keyOf(top[i - 1]))
  if (distinct.length === 1) {
    const path = new Set<ExceptionValue>()
    for (let x: ExceptionValue | undefined = distinct[0]; x && !path.has(x); x = children(x)[0]) path.add(x)
    return [...path]
  }
  return [...distinct, root]
}

/** Grouping v2's default fingerprint: the app's frames, else all frames, else the exceptions' types and values */
function defaultComponentsV2(event: NormalizedEvent, states: FrameState[][], limit: number): string[] {
  if (!event.exceptions.length) return [parameterize(event.template ?? (event.message || event.title))]
  const stacks = new Map(event.exceptions.map((x, i) => [x, stacksOf(x, states[i], event.platform)]))
  const exceptions = groupedExceptions(event.exceptions, (x) => JSON.stringify([stacks.get(x), tailOf(x, false)]))
  const variant = exceptions.some((x) => stacks.get(x)!.app.length)
    ? 'app'
    : exceptions.some((x) => stacks.get(x)!.system.length)
      ? 'system'
      : 'app'
  // crashyard: the 5 nearest the crash, where Sentry takes them all
  return exceptions.flatMap((x) => {
    const frames = stacks.get(x)![variant]
    return [...frames.slice(-limit).flat(), ...tailOf(x, frames.length > 0)]
  })
}

const isDefault = (part: string) => /^\{\{\s*default\s*\}\}$/.test(part)

/**
 * Version 2: Sentry's built-in stack trace rules and then the project's, over the SDK's in-app flags; the fingerprint
 * a project's rule sets, else the SDK's, else Sentry's built-in one (only over a default fingerprint), else the default
 */
export const fingerprintV2 = async (event: NormalizedEvent, rules: Rules) => sha(componentsV2(event, rules))

/** What version 2 hashes; `limit`, the frames an exception's stack keeps (crashyard's 5; Sentry all) */
export function componentsV2(event: NormalizedEvent, rules: Rules, limit = FRAMES): string[] {
  const states = statesOf(event, rules)
  const view = {
    ...event,
    exceptions: event.exceptions.map((x, e) => ({
      ...x,
      // The states are of the innermost frames: the ones before keep the SDK's flags
      frames: x.frames.map((f, i) => {
        const state = states[e][i - (x.frames.length - states[e].length)]
        return { ...f, inApp: state ? state.inApp : (f.origInApp ?? f.inApp) }
      }),
    })),
  }
  const sdk = event.fingerprint?.length ? event.fingerprint : undefined
  const custom =
    fingerprintRule(view, rules.fingerprint) ??
    (sdk && !sdk.every(isDefault) ? sdk : fingerprintRule(view, BUILTIN_FINGERPRINTS.fingerprint))
  const parts = custom ?? ['{{ default }}']
  return parts.flatMap((p) => (isDefault(p) ? defaultComponentsV2(event, states, limit) : [p]))
}

// The last states worked out per event: hashing and then showing the in-app flags read the same ones. They come from
// the SDK's flags (`origInApp`), which showing them doesn't change
const stateCache = new WeakMap<NormalizedEvent, { rules: Rules; states: FrameState[][] }>()

/** Each exception's frame states under grouping v2: Sentry's built-in rules, then the project's */
export function statesOf(event: NormalizedEvent, rules: Rules): FrameState[][] {
  const hit = stateCache.get(event)
  if (hit?.rules === rules) return hit.states
  const all = [...BUILTIN_RULES.stack, ...rules.stack]
  const out = event.exceptions.map((x) => stackStates(event, groupingFrames(x), all))
  stateCache.set(event, { rules, states: out })
  return out
}

/** Version 1 on a copy, from the SDK's in-app flags: it never changes the event */
async function fingerprintV1(event: NormalizedEvent, rules: Rules): Promise<string> {
  const copy = {
    ...event,
    exceptions: event.exceptions.map((x) => ({
      ...x,
      frames: x.frames.map((f) => ({ ...f, inApp: f.origInApp ?? f.inApp })),
    })),
  }
  return fingerprintOf(applyRules(copy, rules))
}

/**
 * The grouping events are hashed with, each from the event and its project's rules, changing neither. A change that
 * moves fingerprints adds the next version here and bumps this: each project then computes both for 30 days and maps
 * the new hash to the issue of the old (`groupingOf` in store.ts), so no open issue splits. Version 1 is crashyard's
 * first grouping, unchanged; version 2 Sentry's
 */
export const GROUPING_VERSION = 2
export type Hasher = (event: NormalizedEvent, rules: Rules) => Promise<string>
export const HASHERS: Record<number, Hasher> = { 1: fingerprintV1, 2: fingerprintV2 }

/** Shows on the event the in-app flags of `version`'s rules, as Sentry does, and takes the culprit again from them */
export function showInApp(event: NormalizedEvent, rules: Rules, version: number) {
  if (version >= 2) setInApp(event, statesOf(event, rules))
  else applyRules(event, rules)
}
