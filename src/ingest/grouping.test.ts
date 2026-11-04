import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeEvent } from './event'
import { jsModule, trimFunction, withoutBundleHash } from './functions'
import { componentsV2, HASHERS } from './grouping'
import { parameterize } from './parameterize'
import { NO_RULES, parseGroupingRules } from './rules'

// Sentry's own grouping tests (getsentry/sentry 24.10.0, scripts/sentry-grouping-fixtures.mjs): grouping v2 groups
// each event by the same values as Sentry, every frame counted, but where a known difference applies
const dir = 'test/fixtures/sentry-grouping'
const expected = JSON.parse(readFileSync(`${dir}/expected.json`, 'utf8')) as Record<string, { values: unknown[] }>

const WITHOUT_EXCEPTION = 'an event without an exception groups by its text, not its threads'
const SECURITY = 'a security report gets its fingerprint at the door (security.ts)'
const URL_MODULE = 'a script’s module is made from its URL, as Sentry does to real events but not in its tests'
const DIFFERENT: Record<string, string> = {
  'block_invoke.json': WITHOUT_EXCEPTION,
  'cocoa_dispatch_client_callout.json': WITHOUT_EXCEPTION,
  'threads-compute-hashes.json': WITHOUT_EXCEPTION,
  'csp-img-src.json': SECURITY,
  'csp-no-blocked-uri.json': SECURITY,
  'csp-script-data-uri.json': SECURITY,
  'csp-script-src-uri.json': SECURITY,
  'csp-style-src-elem.json': SECURITY,
  'csp.json': SECURITY,
  'expectct.json': SECURITY,
  'hpkp.json': SECURITY,
  'frame-ignores-filename-from-url-origin-corner-cases.json': URL_MODULE,
  'frame-ignores-filename-if-http.json': URL_MODULE,
  'frame-ignores-filename-if-https.json': URL_MODULE,
  'javascript-unpkg.json': URL_MODULE,
  'exception-without-type.json': 'an exception without a type is an Error',
  'javascript-exception-fallback-to-message-whistles.json': 'emails are scrubbed before an event is stored',
  'template-compute-hashes.json': 'template frames (Django’s) aren’t grouped apart',
  'unity.json': 'a frame’s function is read before its raw_function',
  'group_307_event_657.json': 'an unnamed libsystem_pthread frame is a system frame, crashyard naming none of Apple’s',
  'native-limit-frames.json': 'max-frames= isn’t a rule crashyard knows',
  'native-unlimited-frames.json': 'max-frames= isn’t a rule crashyard knows',
  'stacktrace-enforce-min-frames.json': 'min-frames= isn’t a rule crashyard knows',
}

/** Shapes no SDK sends today, read as Sentry reads them: one exception object, a stack with no exception */
function current(raw: Record<string, unknown>) {
  const e = { ...raw }
  const x = e.exception as Record<string, unknown> | undefined
  if (x && !Array.isArray(x) && !x.values) e.exception = [x]
  if (e.stacktrace && !e.exception)
    e.exception = [{ type: '', mechanism: { synthetic: true }, stacktrace: e.stacktrace }]
  return e
}

async function components(file: string) {
  const raw = JSON.parse(readFileSync(`${dir}/events/${file}`, 'utf8'))
  const rules = raw._grouping?.enhancements ? parseGroupingRules(raw._grouping.enhancements) : NO_RULES
  if ('error' in rules) throw new Error(rules.error)
  return componentsV2(await normalizeEvent(current(raw), 1_700_000_000_000), rules, Infinity)
}

describe('grouping v2 against Sentry', () => {
  for (const file of readdirSync(`${dir}/events`).sort()) {
    const values = expected[file].values.map(String)
    // A known difference is checked to still be one, so this list can't go stale
    if (DIFFERENT[file])
      it.fails(`${file}: ${DIFFERENT[file]}`, async () => expect(await components(file)).toEqual(values))
    else it(file, async () => expect(await components(file)).toEqual(values))
  }
})

// App hangs from an iPhone and Mac app (crashyard's own data, the app's name changed): one stack sampled while the main
// thread was busy, which grouping v2 groups by the app's frames, else by the hang alone
describe('grouping v2 of app hangs', () => {
  const hang = async (name: string, change: (x: Record<string, unknown>) => void = () => {}) => {
    const raw = JSON.parse(readFileSync(`test/fixtures/hangs/app-${name}.json`, 'utf8'))
    change(raw.exception.values[0])
    return HASHERS[2](await normalizeEvent(raw, 1_700_000_000_000), NO_RULES)
  }

  it('makes one issue of hangs with no frame of the app’s own, wherever the system was', async () => {
    // A Mac app in SwiftUI's layout (two samples), in AppKit, an idle iPhone app asleep for an hour, the SDK itself
    const all = await Promise.all(['29-1', '29-2', '37-1', '41-1', '40-1'].map((n) => hang(n)))
    expect(new Set(all).size).toBe(1)
  })

  it('keeps a hang in the app’s code apart, the same whatever the SDK calls it', async () => {
    const pdf = await hang('42-1')
    expect(pdf).not.toBe(await hang('29-1'))
    // A watchdog's kill and macOS's older name are the same hang
    expect(await hang('42-1', (x) => (x.type = 'Fatal App Hang Fully Blocked'))).toBe(pdf)
    expect(await hang('42-1', (x) => ((x.type = 'App Hanging'), (x.value = 'App hanging for at least 2000 ms.')))).toBe(
      pdf,
    )
    // Three samples of one busy loop in the app's editor
    expect(new Set(await Promise.all(['33-1', '33-2', '33-3'].map((n) => hang(n)))).size).toBe(1)
  })
})

describe('function names and script modules', () => {
  it('keeps a Swift function’s name across builds', () => {
    const swift = (name: string) => trimFunction(name, 'cocoa')
    expect(swift('closure #1 () in closure #1 @Sendable (NWPath) in SyncScheduler.startNetworkMonitor()')).toBe(
      'closure in SyncScheduler.startNetworkMonitor',
    )
    expect(swift('specialized static PdfRenderer.paginate(_: WKWebView, paper: CGSize)')).toBe('PdfRenderer.paginate')
    expect(swift('@objc CodeBlockHostView.layoutSubviews()')).toBe('CodeBlockHostView.layoutSubviews')
    expect(swift('-[SentryHub capture:]')).toBe('-[SentryHub capture:]')
  })

  it('names a script after its URL without versions or a bundler’s hash', () => {
    expect(jsModule('http://google.com/js/v1.0/foo/bar/baz.js')).toBe('foo/bar/baz')
    expect(withoutBundleHash('index-DS-ilMhP.js')).toBe('index.js')
    expect(withoutBundleHash('assets/sentry-BOYmULle')).toBe('assets/sentry')
    expect(withoutBundleHash('user-settings.js')).toBe('user-settings.js')
  })
})

// What anyone with a DSN can send: grouping must stay cheap and never throw
describe('grouping v2 of hostile events', () => {
  const event = (exceptions: unknown[]) => normalizeEvent({ platform: 'cocoa', exception: { values: exceptions } }, 0)
  const timed = async (exceptions: unknown[]) => {
    const e = await event(exceptions)
    const start = performance.now()
    await HASHERS[2](e, NO_RULES)
    return performance.now() - start
  }

  it('reads only the 250 frames nearest the crash', async () => {
    const frames = Array.from({ length: 30_000 }, () => ({ function: '__cxa_throw', in_app: true }))
    expect(await timed([{ type: 'E', stacktrace: { frames } }])).toBeLessThan(500)
  })

  it('parameterizes at most 1,000 characters of a value', async () => {
    expect(await timed([{ type: 'E', value: 'a.'.repeat(50_000) }])).toBeLessThan(200)
    expect(parameterize(`${'a'.repeat(1500)} 42`)).toBe(`${'a'.repeat(1000)}...`)
  })

  it('takes a deep or cyclic exception group, and long names', async () => {
    const deep = Array.from({ length: 5000 }, (_, i) => ({
      type: 'Group',
      value: '',
      mechanism: { exception_id: i, parent_id: i ? i - 1 : undefined, is_exception_group: true },
    }))
    await expect(HASHERS[2](await event(deep), NO_RULES)).resolves.toMatch(/^[0-9a-f]{32}$/)
    expect(trimFunction(`${'<'.repeat(8000)}a${'>'.repeat(8000)}`, 'native')).toBeTypeOf('string')
    expect(trimFunction('{lambda('.repeat(20_000), 'native')).toBeTypeOf('string')
  })
})
