import { describe, expect, it } from 'vitest'
import { ISSUE_KEYS, LOG_KEYS } from './query'
import { apply, contextAt, suggest } from './suggest'

const TAGS = [
  { key: 'device', description: 'Tag', kind: 'tag' as const },
  { key: 'os', description: 'Tag', kind: 'tag' as const },
]
const issues = { keys: [...ISSUE_KEYS, ...TAGS], values: [] }

describe('suggestions', () => {
  it('proposes keys for what is typed', () => {
    expect(contextAt('lev', 3)).toEqual({ tokenIndex: 0, part: 'key', prefix: 'lev', negate: false })
    expect(suggest(contextAt('lev', 3), issues)[0]).toEqual({ kind: 'key', key: 'level', description: 'Level' })
    expect(contextAt('is:unresolved !de', 17)).toMatchObject({ tokenIndex: 1, part: 'key', prefix: 'de', negate: true })
    expect(suggest(contextAt('dev', 3), issues).map((s) => s.kind === 'key' && s.key)).toEqual(['device'])
  })

  it('starts with the built-ins, is and level first, then the stored tags', () => {
    const keys = suggest(contextAt('', 0), issues).map((s) => s.kind === 'key' && s.key)
    expect(keys.slice(0, 2)).toEqual(['is', 'level'])
    expect(keys.slice(-2)).toEqual(['device', 'os'])
    expect(contextAt('crash ', 6)).toEqual({ tokenIndex: 1, part: 'key', prefix: '', negate: false })
  })

  it('proposes a key’s values, by prefix, case-insensitive', () => {
    expect(contextAt('level:', 6)).toEqual({
      tokenIndex: 0,
      part: 'value',
      key: 'level',
      prefix: '',
      negate: false,
      op: ':',
    })
    const all = suggest(contextAt('level:', 6), issues)
    expect(all.filter((s) => s.kind === 'value').map((s) => s.kind === 'value' && s.value)).toEqual([
      'fatal',
      'error',
      'warning',
      'info',
      'debug',
    ])
    expect(suggest(contextAt('level:ER', 8), issues)[0]).toEqual({ kind: 'value', key: 'level', value: 'error' })
    const values = {
      keys: issues.keys,
      values: [
        { value: 'iPhone 15', count: 9 },
        { value: 'iPad', count: 3 },
      ],
    }
    expect(suggest(contextAt('device:"iph', 11), values)).toEqual([
      { kind: 'value', key: 'device', value: 'iPhone 15', count: 9 },
    ])
    expect(suggest(contextAt('has:', 4), issues).filter((s) => s.kind === 'value')).toHaveLength(2)
    expect(suggest(contextAt('level:', 6), { keys: LOG_KEYS, values: [] })[3]).toMatchObject({ value: 'info' })
  })

  it('offers ! for a key, and comparisons for numbers and times', () => {
    expect(suggest(contextAt('level:', 6), issues).filter((s) => s.kind === 'operator')).toEqual([
      { kind: 'operator', key: 'level', op: '!' },
    ])
    expect(suggest(contextAt('!level:', 7), issues).filter((s) => s.kind === 'operator')).toEqual([])
    expect(suggest(contextAt('times:', 6), issues).map((s) => s.kind === 'operator' && s.op)).toEqual([
      '!',
      '>',
      '<',
      '>=',
      '<=',
    ])
    expect(suggest(contextAt('times:>', 7), issues).map((s) => s.kind === 'operator' && s.op)).toEqual([
      '!',
      '<',
      '>=',
      '<=',
    ])
    expect(apply('times:', 6, { kind: 'operator', key: 'times', op: '>' })).toEqual({ query: 'times:>', caret: 7 })
    expect(apply('level: crash', 6, { kind: 'operator', key: 'level', op: '!' })).toEqual({
      query: '!level: crash',
      caret: 7,
    })
  })

  it('applies a key, then a value', () => {
    expect(apply('lev', 3, { kind: 'key', key: 'level', description: '' })).toEqual({ query: 'level:', caret: 6 })
    expect(apply('level:er', 8, { kind: 'value', key: 'level', value: 'error' })).toEqual({
      query: 'level:error ',
      caret: 12,
    })
    expect(apply('!dev', 4, { kind: 'key', key: 'device', description: '' })).toEqual({ query: '!device:', caret: 8 })
    // In the key of a whole token, only the key changes
    expect(apply('lev:error', 2, { kind: 'key', key: 'level', description: '' })).toEqual({
      query: 'level:error',
      caret: 6,
    })
  })

  it('quotes a value with a space and keeps the tokens after it', () => {
    expect(apply('is:unresolved device:iP crash', 23, { kind: 'value', key: 'device', value: 'iPad Pro' })).toEqual({
      query: 'is:unresolved device:"iPad Pro" crash',
      caret: 32,
    })
    expect(apply('crash', 0, { kind: 'key', key: 'level', description: '' })).toEqual({
      query: 'level: crash',
      caret: 6,
    })
    expect(apply('!level:', 7, { kind: 'value', key: 'level', value: 'fatal' })).toEqual({
      query: '!level:fatal ',
      caret: 13,
    })
  })

  it('adds a value to a list being typed', () => {
    expect(contextAt('level:[error,fa', 15)).toMatchObject({ part: 'value', key: 'level', prefix: 'fa' })
    expect(apply('level:[error,fa', 15, { kind: 'value', key: 'level', value: 'fatal' })).toEqual({
      query: 'level:[error,fatal] ',
      caret: 20,
    })
    expect(apply('device:["iPad Pro",] x', 19, { kind: 'value', key: 'device', value: 'Mac' })).toEqual({
      query: 'device:["iPad Pro",Mac] x',
      caret: 24,
    })
  })

  it('keeps an open quote going to the caret, spaces and all', () => {
    expect(contextAt('release:"1.0 b', 14)).toEqual({
      tokenIndex: 0,
      part: 'value',
      key: 'release',
      prefix: '1.0 b',
      negate: false,
      op: ':',
    })
    expect(contextAt('is:new tag:[a,"b c', 18)).toMatchObject({
      tokenIndex: 1,
      part: 'value',
      key: 'tag',
      prefix: 'b c',
    })
    expect(apply('release:"1.0 b', 14, { kind: 'value', key: 'release', value: '1.0 beta' })).toEqual({
      query: 'release:"1.0 beta" ',
      caret: 19,
    })
    // Closed, the next word is a word again
    expect(contextAt('release:"1.0" b', 15)).toMatchObject({ tokenIndex: 1, part: 'key', prefix: 'b' })
  })
})
