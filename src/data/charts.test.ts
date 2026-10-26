import { describe, expect, it } from 'vitest'
import { buckets, change, fill, intervalFor, scoped, topWithOther } from './charts'

describe('charts', () => {
  it('starts hourly buckets at the hour that holds `from`, up to `to`', () => {
    expect(buckets(Date.UTC(2026, 0, 1, 10, 30), Date.UTC(2026, 0, 1, 13), '1h')).toEqual([
      Date.UTC(2026, 0, 1, 10),
      Date.UTC(2026, 0, 1, 11),
      Date.UTC(2026, 0, 1, 12),
      Date.UTC(2026, 0, 1, 13),
    ])
  })

  it('starts daily buckets at midnight UTC', () => {
    const even = buckets(Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 3), '1d')
    expect(even).toEqual([Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2), Date.UTC(2026, 0, 3)])
    const odd = buckets(Date.UTC(2026, 0, 1, 18), Date.UTC(2026, 0, 4, 6), '1d')
    expect(odd).toEqual([Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2), Date.UTC(2026, 0, 3), Date.UTC(2026, 0, 4)])
    expect(buckets(Date.UTC(2026, 0, 2), Date.UTC(2026, 0, 1), '1d')).toEqual([])
  })

  it('picks the bucket for a span: a minute to an hour, 5 minutes to 6 hours, an hour to a week, else a day', () => {
    expect(intervalFor(36e5)).toBe('1m')
    expect(intervalFor(36e5 + 1)).toBe('5m')
    expect(intervalFor(6 * 36e5)).toBe('5m')
    expect(intervalFor(6 * 36e5 + 1)).toBe('1h')
    expect(intervalFor(7 * 864e5)).toBe('1h')
    expect(intervalFor(7 * 864e5 + 1)).toBe('1d')
    expect(intervalFor(90 * 864e5)).toBe('1d')
  })

  it('starts minute and 5-minute buckets on their UTC boundary', () => {
    const at = Date.UTC(2026, 0, 1, 10, 7, 30)
    expect(buckets(at, at + 3 * 6e4, '1m')).toEqual([0, 1, 2, 3].map((i) => Date.UTC(2026, 0, 1, 10, 7 + i)))
    expect(buckets(at, Date.UTC(2026, 0, 1, 10, 20), '5m')).toEqual(
      [5, 10, 15, 20].map((m) => Date.UTC(2026, 0, 1, 10, m)),
    )
  })

  it('fills buckets given as ms the same way', () => {
    expect(
      fill(
        [
          { at: 120, level: 'warn', count: 2 },
          { at: 60, level: 'trace', count: 1 },
          { at: 60, level: 'error', count: 3 },
        ],
        [0, 60, 120],
      ),
    ).toEqual([
      { level: 'error', counts: [0, 3, 0] },
      { level: 'warn', counts: [0, 0, 2] },
      { level: 'trace', counts: [0, 1, 0] },
    ])
  })

  it('fills sparse rows with zeros, a series per level, most severe first', () => {
    const days = ['2026-01-01', '2026-01-02', '2026-01-03']
    expect(
      fill(
        [
          { at: '2026-01-03', level: 'info', count: 4 },
          { at: '2026-01-01', level: 'error', count: 2 },
          { at: '2026-01-03', level: 'error', count: 1 },
          { at: '2026-01-02', level: 'fatal', count: 5 },
          { at: '2026-01-02', level: 'custom', count: 3 },
          { at: '2025-12-31', level: 'debug', count: 9 },
        ],
        days,
      ),
    ).toEqual([
      { level: 'fatal', counts: [0, 5, 0] },
      { level: 'error', counts: [2, 0, 1] },
      { level: 'info', counts: [0, 0, 4] },
      { level: 'custom', counts: [0, 3, 0] },
    ])
    expect(fill([], days)).toEqual([])
  })

  it('narrows a filter to a project, and to the slugs of project:, as the list does', () => {
    expect(scoped({ where: ['i.level = ?'], params: ['error'], projectSlugs: ['a', 'b'] }, 7)).toEqual({
      where: ['i.level = ?', 'i.project_id = ?', 'i.project_id IN (SELECT id FROM projects WHERE slug IN (?,?))'],
      params: ['error', 7, 'a', 'b'],
    })
    expect(scoped({ where: [], params: [], projectSlugs: [] }, undefined)).toEqual({ where: [], params: [] })
  })

  it('keeps the largest series in order and sums the rest into other, bucket by bucket', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ value: `v${i}`, counts: [i, 1] }))
    const top = topWithOther(rows, 8)
    expect(top.map((r) => r.value)).toEqual(['v9', 'v8', 'v7', 'v6', 'v5', 'v4', 'v3', 'v2', null])
    expect(top.at(-1)!.counts).toEqual([1, 2])
    expect(topWithOther(rows.slice(0, 3), 8).map((r) => r.value)).toEqual(['v2', 'v1', 'v0'])
    expect(topWithOther([], 8)).toEqual([])
  })

  it('gives the change against before, none when there was nothing before', () => {
    expect(change(15, 10)).toBe(0.5)
    expect(change(5, 10)).toBe(-0.5)
    expect(change(5, 0)).toBeNull()
    expect(change(0, 0)).toBeNull()
  })
})
