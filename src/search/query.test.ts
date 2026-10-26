import { describe, expect, it } from 'vitest'
import {
  addValue,
  isSearchableKey,
  issueFilter,
  logAttributeKey,
  logFilter,
  removeToken,
  setToken,
  timeOf,
  type Token,
  tokenize,
  unparse,
  withToken,
} from './query'

const NOW = Date.UTC(2026, 9, 25)

describe('search', () => {
  it('reads keys, operators, negation, quotes and words', () => {
    expect(tokenize('is:unresolved !os:Android times:>10 "audio engine" crash device:"iPad Pro"')).toEqual([
      { key: 'is', op: ':', value: 'unresolved', negate: false },
      { key: 'os', op: ':', value: 'Android', negate: true },
      { key: 'times', op: '>', value: '10', negate: false },
      { op: ':', value: 'audio engine', negate: false },
      { op: ':', value: 'crash', negate: false },
      { key: 'device', op: ':', value: 'iPad Pro', negate: false },
    ])
  })

  it('rewrites one key and keeps the rest', () => {
    expect(withToken('is:unresolved crash device:"iPad Pro"', 'is', 'resolved')).toBe(
      'is:resolved crash device:"iPad Pro"',
    )
    expect(withToken('is:unresolved crash', 'is')).toBe('crash')
  })

  it('turns tokens into SQL with their values as parameters', () => {
    const f = issueFilter('is:unresolved level:fatal release:1.0* !environment:development times:>=5 audio eng', NOW)
    expect(f.where).toEqual([
      'i.status = ?',
      'i.level = ?',
      'EXISTS (SELECT 1 FROM issue_tag_values v WHERE v.issue_id = i.id AND v.key = ? AND v.value GLOB ?)',
      'NOT (EXISTS (SELECT 1 FROM issue_tag_values v WHERE v.issue_id = i.id AND v.key = ? AND v.value = ?))',
      'i.count >= ?',
      'i.id IN (SELECT rowid FROM issues_fts WHERE issues_fts MATCH ?)',
    ])
    expect(f.params).toEqual([
      'unresolved',
      'fatal',
      'release',
      '1.0*',
      'environment',
      'development',
      5,
      '"audio"* "eng"*',
    ])
  })

  it('reads times as "within the last…" and dates', () => {
    expect(timeOf('-24h', NOW)).toBe(NOW - 864e5)
    expect(timeOf('2026-10-01', NOW)).toBe(Date.UTC(2026, 9, 1))
    expect(issueFilter('lastSeen:-24h', NOW)).toMatchObject({ where: ['i.last_seen >= ?'], params: [NOW - 864e5] })
    expect(issueFilter('lastSeen:+30d', NOW)).toMatchObject({ where: ['i.last_seen < ?'], params: [NOW - 30 * 864e5] })
    expect(issueFilter('firstSeen:<-7d', NOW)).toMatchObject({ where: ['i.first_seen > ?'] })
    expect(issueFilter('firstSeen:>2026-10-01', NOW)).toMatchObject({ where: ['i.first_seen > ?'] })
  })

  it('keeps project slugs apart, for the project picker', () => {
    expect(issueFilter('project:pocketband is:new', NOW)).toMatchObject({
      projectSlugs: ['pocketband'],
      where: ["i.status = 'unresolved' AND i.substatus = 'new' AND i.first_seen >= ?"],
    })
  })

  it('searches logs by level, columns, attributes and text', () => {
    const f = logFilter('level:warning release:1.0 song:42 !mode:live "slow export" trace:abc', NOW)
    expect(f.where).toEqual([
      'l.level = ?',
      'l.release = ?',
      'EXISTS (SELECT 1 FROM log_attributes a WHERE a.log_id = l.id AND a.key = ? AND a.value = ?)',
      'NOT (EXISTS (SELECT 1 FROM log_attributes a WHERE a.log_id = l.id AND a.key = ? AND a.value = ?))',
      'l.trace_id = ?',
      'l.id IN (SELECT rowid FROM logs_fts WHERE logs_fts MATCH ?)',
    ])
    expect(f.params).toEqual(['warn', '1.0', 'song', '42', 'mode', 'live', 'abc', '"slow"* "export"*'])
  })

  it('finds the issues of a trace', () => {
    expect(issueFilter('trace:abc', NOW).where).toEqual([
      'EXISTS (SELECT 1 FROM events e WHERE e.issue_id = i.id AND e.trace_id = ?)',
    ])
  })

  it('reads lists of values, quoted or not, and negated', () => {
    expect(tokenize('release:[1.0,"2 0"] !level:[error,fatal]')).toEqual([
      { key: 'release', op: ':', value: '1.0,2 0', values: ['1.0', '2 0'], negate: false },
      { key: 'level', op: ':', value: 'error,fatal', values: ['error', 'fatal'], negate: true },
    ])
    expect(tokenize('tag:["a,b", c ,"d \\"e\\""]')[0].values).toEqual(['a,b', 'c', 'd "e"'])
    // A list needs a key: a bare one is a word
    expect(tokenize('[a,b]')).toEqual([{ op: ':', value: '[a,b]', negate: false }])
  })

  it.each([
    'is:unresolved level:error',
    'release:[1.0,"2 0"]',
    'msg:"a \\"quoted\\" b"',
    '!device:iPad*',
    'times:>10',
    '"two words"',
    'url:"https://x.dev/a"',
    'tag:["a,b","[c]",d]',
  ])('writes %s back as it was read', (q) => {
    expect(unparse(tokenize(q))).toBe(q)
    expect(tokenize(unparse(tokenize(q)))).toEqual(tokenize(q))
  })

  it('quotes values that would read as something else', () => {
    for (const value of ['a b', 'a,b', '[x]', 'k:v', '!x', '>5', 'say "hi"'])
      expect(tokenize(unparse([{ key: 'tag', op: ':', value, negate: false }]))).toEqual([
        { key: 'tag', op: ':', value, negate: false },
      ])
    expect(tokenize(unparse([{ op: ':', value: 'k:v', negate: false }]))).toEqual([
      { op: ':', value: 'k:v', negate: false },
    ])
  })

  it('changes and removes one token, keeping the others', () => {
    const q = 'is:unresolved device:"iPad Pro" crash'
    expect(setToken(q, 1, { key: 'device', op: ':', value: 'iPad Pro', negate: true })).toBe(
      'is:unresolved !device:"iPad Pro" crash',
    )
    expect(setToken(q, 3, { key: 'level', op: ':', value: 'error', negate: false })).toBe(`${q} level:error`)
    expect(removeToken(q, 0)).toBe('device:"iPad Pro" crash')
  })

  it('includes and excludes values, as lists', () => {
    expect(addValue('level:error', 'level', 'fatal', false)).toBe('level:[error,fatal]')
    expect(addValue('level:[error,fatal]', 'level', 'fatal', false)).toBe('level:[error,fatal]')
    expect(addValue('level:error', 'level', 'error', true)).toBe('!level:error')
    expect(addValue('', 'os', 'iOS 18', true)).toBe('!os:"iOS 18"')
    expect(addValue('is:unresolved !os:Android', 'os', 'iOS 18', true)).toBe('is:unresolved !os:[Android,"iOS 18"]')
    expect(addValue('level:[error,fatal] crash', 'level', 'fatal', true)).toBe('level:error crash !level:fatal')
    expect(addValue('!level:fatal', 'level', 'fatal', false)).toBe('level:fatal')
    expect(addValue('times:>5', 'times', '7', false)).toBe('times:>5 times:7')
  })

  it('turns lists into IN, or an OR of matches with a *', () => {
    expect(issueFilter('level:[error,fatal]', NOW)).toMatchObject({
      where: ['i.level IN (?,?)'],
      params: ['error', 'fatal'],
    })
    expect(issueFilter('!level:[error,fatal]', NOW)).toMatchObject({
      where: ['NOT (i.level IN (?,?))'],
      params: ['error', 'fatal'],
    })
    expect(issueFilter('device:[iPad,"iPhone 15"]', NOW)).toMatchObject({
      where: ['EXISTS (SELECT 1 FROM issue_tag_values v WHERE v.issue_id = i.id AND v.key = ? AND v.value IN (?,?))'],
      params: ['device', 'iPad', 'iPhone 15'],
    })
    expect(issueFilter('device:[iPad*,Mac]', NOW).where).toEqual([
      'EXISTS (SELECT 1 FROM issue_tag_values v WHERE v.issue_id = i.id AND v.key = ? AND (v.value GLOB ? OR v.value = ?))',
    ])
    expect(issueFilter('is:[resolved,regressed]', NOW)).toMatchObject({
      where: ["((i.status = ?) OR (i.status = 'unresolved' AND i.substatus = 'regressed'))"],
      params: ['resolved'],
    })
    expect(issueFilter('project:[a,b] !project:[c,d]', NOW)).toMatchObject({
      projectSlugs: ['a', 'b'],
      where: ['i.project_id NOT IN (SELECT id FROM projects WHERE slug IN (?,?))'],
      params: ['c', 'd'],
    })
    expect(issueFilter('times:[1,2]', NOW).where).toEqual([])
  })

  it('turns log lists into IN, with level aliases on each', () => {
    expect(logFilter('level:[warning,error] !mode:[live,"two words"]', NOW)).toMatchObject({
      where: [
        'l.level IN (?,?)',
        'NOT (EXISTS (SELECT 1 FROM log_attributes a WHERE a.log_id = l.id AND a.key = ? AND a.value IN (?,?)))',
      ],
      params: ['warn', 'error', 'mode', 'live', 'two words'],
    })
    expect(logFilter('message:["slow export",crash]', NOW)).toMatchObject({
      where: ['l.id IN (SELECT rowid FROM logs_fts WHERE logs_fts MATCH ?)'],
      params: ['("slow"* "export"*) OR ("crash"*)'],
    })
  })

  it('keeps backslashes, spaces in quotes and odd values through a list', () => {
    const twice = addValue(addValue('', 'path', 'a\\b', false), 'path', 'c', false)
    expect(tokenize(twice)[0].values).toEqual(['a\\b', 'c'])
    expect(tokenize(unparse(tokenize('k:["a\\\\",b]')))[0].values).toEqual(['a\\', 'b'])
    expect(tokenize(addValue('k:[x,"y "]', 'k', 'z', false))[0].values).toEqual(['x', 'y ', 'z'])
    const q = 'release:["\tbb\\\\",">\t:"]'
    expect(tokenize(addValue(q, 'level', 'error', false))[0]).toEqual(tokenize(q)[0])
  })

  it('only writes keys the grammar can read back', () => {
    for (const key of ['song', 'sentry.sdk.name', 'a-b_c', 'x9']) expect(isSearchableKey(key)).toBe(true)
    for (const key of ['song name', 'sentry:user', 'a/b', '', 'ü']) expect(isSearchableKey(key)).toBe(false)
    expect(addValue('level:error', 'song name', 'x', false)).toBe('level:error')
    expect(logAttributeKey('song')).toBe('song')
    expect(logAttributeKey('level')).toBeUndefined()
    expect(logAttributeKey('a/b')).toBeUndefined()
  })

  it('reads back any tokens it writes, and adding a value leaves the other keys alone', () => {
    // A small seeded PRNG (mulberry32), so a failure is the same every run
    let seed = 42
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]
    const KEY = 'abz09_.-'
    const VALUE = ['a', 'b', 'Z', '1', ' ', '"', '\\', ',', '[', ']', ':', '*', '\t', '!', '<', '>', '=', '-']
    const string = (alphabet: readonly string[], max: number) =>
      Array.from({ length: 1 + Math.floor(random() * max) }, () => pick(alphabet)).join('')
    // What the grammar reads: a value is never empty, nor only spaces in a list (an item is trimmed outside quotes)
    const value = () => string(VALUE, 6)
    const token = (): Token => {
      const negate = random() < 0.3
      if (random() < 0.2) return { op: ':', value: value(), negate }
      const key = string([...KEY], 5)
      const op = random() < 0.8 ? ':' : pick(['>', '<', '>=', '<='] as const)
      if (random() < 0.4) {
        const values = Array.from({ length: 1 + Math.floor(random() * 3) }, value)
        return { key, op, value: values.join(','), values, negate }
      }
      return { key, op, value: value(), negate }
    }
    for (let i = 0; i < 3000; i++) {
      const tokens = Array.from({ length: Math.floor(random() * 4) }, token)
      const q = unparse(tokens)
      expect(tokenize(q), q).toEqual(tokens)
      const key = random() < 0.5 && tokens[0]?.key ? tokens[0].key : string([...KEY], 3)
      const others = (ts: Token[]) => ts.filter((t) => t.key !== key)
      expect(others(tokenize(addValue(q, key, value(), random() < 0.5))), q).toEqual(others(tokens))
    }
  })
})
