import { describe, expect, it } from 'vitest'
import { issueFilter, logFilter, timeOf, tokenize, withToken } from './query'

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
})
