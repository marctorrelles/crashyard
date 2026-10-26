import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { type Frame, normalizeEvent, type NormalizedEvent } from './event'
import { fingerprintOf, HASHERS } from './grouping'
import { applyRules, globToRegExp, parseGroupingRules, type Rules } from './rules'
import { groupingOf, type Project, storeEvent } from './store'

const rules = (text: string) => {
  const r = parseGroupingRules(text)
  if ('error' in r) throw new Error(`line ${r.line}: ${r.error}`)
  return r as Rules
}
const frame = (f: Partial<Frame>): Frame => ({ inApp: true, ...f })
const base = (over: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  id: 'a'.repeat(32),
  timestamp: 0,
  received: 0,
  level: 'error',
  platform: 'javascript',
  type: 'error',
  title: 'TimeoutError: took too long',
  culprit: '',
  message: '',
  exceptions: [
    {
      type: 'TimeoutError',
      value: 'took 3001 ms',
      frames: [frame({ function: 'main', module: 'App' }), frame({ function: 'fetch', module: 'App.Net' })],
    },
  ],
  tags: {},
  contexts: {},
  breadcrumbs: [],
  debugImages: [],
  ...over,
})
const hash = (e: NormalizedEvent, r: Rules) => fingerprintOf(applyRules(e, r))

describe('grouping rules', () => {
  it('groups every timeout together with error.type', async () => {
    const r = rules('# timeouts are one issue\nerror.type:TimeoutError -> timeouts')
    const a = base()
    const b = base({
      exceptions: [{ type: 'TimeoutError', value: 'other', frames: [frame({ function: 'save', module: 'Db' })] }],
    })
    expect(await hash(a, r)).toBe(await hash(b, r))
    expect(await hash(a, r)).not.toBe(await fingerprintOf(a))
    // A different type isn't touched
    const c = base({ exceptions: [{ type: 'RangeError', value: 'x', frames: [] }] })
    expect(await hash(c, r)).toBe(await fingerprintOf(c))
  })

  it('makes vendor frames not in-app before grouping with stack.module', async () => {
    const r = rules('stack.module:Vendor* -app')
    const e = base({
      exceptions: [
        {
          type: 'Error',
          value: 'x',
          frames: [frame({ function: 'main', module: 'App' }), frame({ function: 'parse', module: 'VendorKit.Json' })],
        },
      ],
    })
    const other = structuredClone(e)
    other.exceptions[0].frames[1].function = 'decode'
    // Without the rule the vendor frame splits them; with it, both group by the app's frame alone
    expect(await fingerprintOf(e)).not.toBe(await fingerprintOf(other))
    expect(await hash(e, r)).toBe(await hash(other, r))
    expect(e.exceptions[0].frames[1].inApp).toBe(false) // shown as Sentry does, on the event itself
  })

  it('matches a message glob, case aside, and fills variables', async () => {
    const r = rules('message:"*connection reset*" -> net, {{ level }}')
    const a = base({ exceptions: [], message: 'Upload failed: Connection reset by peer' })
    const b = base({ exceptions: [], message: 'sync: connection reset' })
    expect(await hash(a, r)).toBe(await hash(b, r))
    expect(applyRules(a, r).fingerprint).toEqual(['net', 'error'])
    expect(await hash(base({ exceptions: [], message: 'disk full' }), r)).not.toBe(await hash(a, r))
  })

  it('takes frames out of grouping, and frame matchers must hold on one frame', async () => {
    const r = rules('stack.function:log* -group')
    const e = base()
    e.exceptions[0].frames.push(frame({ function: 'logError', module: 'App' }))
    expect(await hash(e, r)).toBe(await fingerprintOf(base()))
    const both = rules('stack.function:main stack.module:App.Net -> x')
    expect(applyRules(base(), both).fingerprint).toBeUndefined()
    expect(applyRules(base(), rules('stack.function:fetch stack.module:App.Net -> x')).fingerprint).toEqual(['x'])
    expect(applyRules(base(), rules('!stack.module:App* -> x')).fingerprint).toBeUndefined()
  })

  it('reads paths with ** and * as Sentry does', () => {
    const re = globToRegExp('**/node_modules/**', { path: true, caseless: true })
    expect(re.test('/app/node_modules/react/index.js')).toBe(true)
    expect(re.test('node_modules/x.js')).toBe(true)
    expect(globToRegExp('src/*.js', { path: true }).test('src/a/b.js')).toBe(false)
    expect(globToRegExp('*/health{/,}', { braces: true, caseless: true }).test('GET /HEALTH/')).toBe(true)
  })

  it('says which line is wrong, and why', () => {
    expect(parseGroupingRules('error.type:A -> a\nerror.kind:B -> b')).toMatchObject({ line: 2 })
    expect(parseGroupingRules('message:"open -> x')).toMatchObject({ line: 1, error: expect.stringMatching(/quote/) })
    expect(parseGroupingRules('stack.function:foo')).toMatchObject({ error: expect.stringMatching(/action/) })
    expect(parseGroupingRules('stack.function:foo -apps')).toMatchObject({ error: expect.stringMatching(/action/) })
    expect(parseGroupingRules('error.type:A ->')).toMatchObject({ error: expect.stringMatching(/fingerprint/) })
    expect(parseGroupingRules('error.type:A -> {{ nope }}')).toMatchObject({ error: expect.stringMatching(/nope/) })
    expect(parseGroupingRules('# only a comment\n\n')).toEqual({ fingerprint: [], stack: [] })
  })
})

describe('grouping versions', () => {
  it('keeps version 1 exactly the hash every fixture had before versions', async () => {
    const before = JSON.parse(readFileSync('src/ingest/grouping-v1.json', 'utf8')) as Record<string, string>
    for (const f of readdirSync('test/fixtures/events').sort()) {
      const e = await normalizeEvent(JSON.parse(readFileSync(`test/fixtures/events/${f}`, 'utf8')), 1_700_000_000_000)
      const none = applyRules(e, rules(''))
      expect(await HASHERS[1](none), f).toBe(before[f])
      expect(await HASHERS[1]({ ...none, fingerprint: ['{{ default }}', 'x'] }), f).toBe(before[`${f} +fingerprint`])
    }
  })

  it('maps a new version’s hash to the issue that holds the old one, for 30 days', async () => {
    const db = sqliteD1()
    db.sqlite.exec("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'app', 'App', 'k', 0)")
    const project = {
      id: 1,
      slug: 'app',
      name: 'App',
      daily_event_quota: 1e6,
      daily_log_quota: 1e6,
      daily_transaction_quota: 1e6,
      grouping_version: 1,
    } as Project
    const e = base()
    const v1 = await HASHERS[1](e)
    await storeEvent(db, project, e, v1)
    const hashers = { ...HASHERS, 2: async (x: NormalizedEvent) => `v2-${await HASHERS[1](x)}` }
    const now = 1_000
    const { fingerprint, version } = await groupingOf(db, project, e, now, hashers, 2)
    expect([fingerprint, version]).toEqual([`v2-${v1}`, 2])
    const row = db.sqlite.prepare('SELECT grouping_version, grouping_previous, grouping_until FROM projects').get()
    expect(row).toEqual({ grouping_version: 2, grouping_previous: 1, grouping_until: now + 30 * 86_400_000 })
    const stored = await storeEvent(db, project, { ...e, id: 'b'.repeat(32) }, fingerprint, undefined, version)
    expect(stored?.isNew).toBe(false)
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM issues').get()).toEqual({ n: 1 })
    // Past the overlap, the old hash isn't computed: a new crash at v2 alone makes its own issue
    const later = { ...e, exceptions: [{ ...e.exceptions[0], type: 'Other' }] }
    await groupingOf(db, project, later, now + 31 * 86_400_000, hashers, 2)
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM issue_fingerprints').get()).toEqual({ n: 1 })
  })
})
