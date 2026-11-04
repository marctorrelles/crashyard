// Function names and JavaScript modules as grouping reads them, ported from Sentry 24.10.0
// (`src/sentry/stacktraces/functions.py` and `src/sentry/lang/javascript/utils.py`, getsentry/sentry, Apache-2.0 since
// 2026-10-15 under its FSL-1.1-Apache-2.0 license): the same crash keeps one name across builds and compilers.

const NATIVE = new Set(['objc', 'cocoa', 'swift', 'native', 'c'])
/** Sentry's behaviour family of a platform: native, javascript or other (`get_behavior_family_for_platform`) */
export const behaviourOf = (platform: string | undefined) =>
  platform && NATIVE.has(platform)
    ? 'native'
    : platform === 'javascript' || platform === 'node'
      ? 'javascript'
      : 'other'

/** `s` without each top-level `start…end` span, which `replace` turns into what it answers */
function replaceEnclosed(s: string, start: string, end: string, replace: (inner: string, at: number) => string) {
  if (!s.includes(start)) return s
  let depth = 0
  let at = 0
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === start) {
      if (depth === 0) at = i
      depth++
    } else if (c === end) {
      depth--
      if (depth === 0) out += replace(s.slice(at + 1, i), at)
    } else if (depth === 0) out += c
  }
  return out
}

const PAIRS: Record<string, string> = { '(': ')', '{': '}', '[': ']', '<': '>' }
/** Whitespace-separated tokens, a bracketed run staying in its token */
function tokensOf(s: string): string[] {
  if (s && !/\s|[({<[]/.test(s)) return [s]
  const out: string[][] = []
  let buf: string[] = []
  const stack: string[] = []
  let end = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c in PAIRS) stack.push(PAIRS[c])
    else if (stack.length && c === stack.at(-1)) {
      stack.pop()
      if (!stack.length) {
        buf.push(s.slice(end, i + 1))
        end = i + 1
      }
    } else if (!stack.length) {
      if (/\s/.test(c)) {
        if (buf.length) out.push(buf)
        buf = []
      } else buf.push(s.slice(end, i + 1))
      end = i + 1
    }
  }
  if (buf.length) out.push(buf)
  return out.map((t) => t.join(''))
}

// gcc `{lambda(…)#1}`, msvc `lambda_<32 hex>`, clang `$_0`
const LAMBDA = /\{lambda\(.*?\)#\d+\}|\blambda_[a-f0-9]{32}\b|\$_\d+\b/g
const LAMBDA_START = /^(?:\{lambda\(.*?\)#\d+\}|\blambda_[a-f0-9]{32}\b|\$_\d+\b)/

/** A native function without its arguments, return type, generics and compiler noise (`trim_native_function_name`) */
function trimNative(name: string, platform: string | undefined): string {
  if (name === '<redacted>' || name === '<unknown>') return name
  // crashyard: 4,000 characters at most, a long C++ template's whole name: the lambda pattern rescans a run of
  // `{lambda(` from every place in it, and generics nest a call deep each
  let fn = name.slice(0, 4000).trim()
  // Objective-C stays as it is
  if (/^[-+]?\[/.test(fn)) return fn
  fn = replaceEnclosed(fn, '[', ']', (v) => (v.startsWith('clone .') ? '' : `[${v}]`)).trimEnd()
  for (let m = /(\bconst\b|&)$/.exec(fn); m; m = /(\bconst\b|&)$/.exec(fn)) fn = fn.slice(0, m.index).trimEnd()
  // Operators would upset the bracket balancing: stand-ins until the end
  fn = fn
    .replaceAll('operator<<', 'operator⟨⟨')
    .replaceAll('operator<', 'operator⟨')
    .replaceAll('operator()', 'operator◯')
    .replaceAll('operator->', 'operator⟿')
    .replaceAll(' -> ', ' ⟿ ')
    .replaceAll("`anonymous namespace'", '〔anonymousnamespace〕')
  if (fn.includes('lambda') || fn.includes('$_')) fn = fn.replace(LAMBDA, 'lambda')
  // MSVC names an inline function's anonymous namespace by its hash
  if (fn.includes('?A0x')) fn = fn.replace(/\?A0x[a-f0-9]{8}::/g, '〔anonymousnamespace〕::')
  fn = replaceEnclosed(fn, '(', ')', (v) => {
    v = v.trim()
    return v === 'anonymous namespace' || v === 'operator' ? `(${v})` : ''
  })
  const generics = (v: string, at: number): string => {
    if (v === 'lambda' || LAMBDA_START.test(v)) return `<${v}>`
    if (at > 0) return '<T>'
    // Rust's `<Foo as Bar>::baz` keeps the type, and a blanket impl's trait
    v = v.replace(/^([A-Z] as )/, '')
    return replaceEnclosed(v, '<', '>', generics).split(' as ')[0]
  }
  fn = replaceEnclosed(fn, '<', '>', generics)
  const thunk = fn.includes('thunk for ')
  const tokens = tokensOf(fn)
  if (tokens.length > 1 && tokens.at(-1) === '<T>') {
    tokens.pop()
    tokens[tokens.length - 1] += ' <T>'
  }
  // The function is the token before Swift's `->`, else the last one
  let token: string | undefined
  if (fn.includes('initialization expression of')) {
    const of = tokens.lastIndexOf('of')
    token = tokens[of + 1]
    if (token === 'static') token = tokens[of + 2]
    if (token?.startsWith(':')) token = token.slice(1)
    token = `initializer expression of ${token}`
  } else if (tokens.length) {
    const arrow = tokens.lastIndexOf('⟿')
    if (arrow >= 0) {
      token = tokens[arrow - 1]
      if (token === 'throws') token = tokens[arrow - 2]
    } else token = tokens.at(-1)
  }
  // No name found: Sentry keeps the whole, and still trims its hash, version and declaration marks below
  if (!token) fn = name
  // A Swift attribute where the name would be: an anonymous function
  else if (token.startsWith('@') && (platform === 'cocoa' || platform === 'swift'))
    fn = `${thunk ? 'thunk for ' : ''}closure`
  else
    fn = (tokens.includes('closure') && token !== 'closure' ? `closure in ${token}` : token)
      .replaceAll('⟨', '<')
      .replaceAll('◯', '()')
      .replaceAll('⟿', '->')
      .replaceAll('〔anonymousnamespace〕', "`anonymous namespace'")
  if (fn.includes('::h')) fn = fn.replace(/::h[a-z0-9]{16}$/, '')
  if (fn.includes('@GLIBC_')) fn = fn.replace(/@@?GLIBC_([0-9.]+)$/, '')
  return fn.includes('@') ? fn.replace(/^@?(.*?)@[0-9]+$/, '$1') : fn
}

/** A frame's function as grouping and stack rules read it (`trim_function_name`): native ones lose their signature */
export function trimFunction(name: string, platform: string | undefined): string {
  if (behaviourOf(platform) === 'native') return trimNative(name, platform)
  return name
}

const CLEAN_MODULE =
  /^(?:\/|(?:(?:java)?scripts?|js|build|static|node_modules|bower_components|[_.~].*?|v?(?:\d+\.)*\d+|[a-f0-9]{7,8}|[a-f0-9]{32}|[a-f0-9]{40})\/)+|(?:[-.][a-f0-9]{7,}$)/gi
const VERSION = /^(?:[a-f0-9]{32}|[a-f0-9]{40}$)/i

/**
 * A module made up from a script's URL, as Sentry names a JavaScript frame that has none (`generate_module`): the
 * path without its query, extension, `.min`, and version or hash folders. `http://example.com/js/v1.0/foo/bar.js`
 * is `foo/bar`
 */
export function jsModule(url: string): string {
  let path: string
  try {
    path = decodeURIComponent(new URL(url).pathname)
  } catch {
    return '<unknown module>'
  }
  // Its extension, as Python's splitext: not a name's leading dot
  path = path.replace(/(?<=[^/.][^/]*)\.[^./]*$/, '')
  if (path.endsWith('.min')) path = path.slice(0, -4)
  const parts = path.split('/')
  const sha = parts.findIndex((p) => VERSION.test(p))
  if (sha >= 0) return parts.slice(sha + 1).join('/')
  return path.replace(CLEAN_MODULE, '') || '<unknown module>'
}

/**
 * A JavaScript file or module without the content hash a bundler (Vite, Rollup, webpack) puts in its name, as in
 * `index-DS-ilMhP.js`: 8 characters of `[A-Za-z0-9_-]` with a digit or a capital, after a `-` or `.`. crashyard's
 * own: without a source map such a frame would group apart on every deploy
 */
export const withoutBundleHash = (name: string) =>
  name.replace(/[-.]([A-Za-z0-9_-]{8})(?=(?:\.[cm]?js)?$)/, (all, hash: string) => (/[0-9A-Z]/.test(hash) ? '' : all))
