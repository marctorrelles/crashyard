import { describe, expect, it } from 'vitest'
import { buckets, fill, scoped } from './charts'

describe('charts', () => {
  it('starts hourly buckets at the hour that holds `from`, up to `to`', () => {
    expect(buckets(Date.UTC(2026, 0, 1, 10, 30), Date.UTC(2026, 0, 1, 13), 'hour')).toEqual([
      Date.UTC(2026, 0, 1, 10),
      Date.UTC(2026, 0, 1, 11),
      Date.UTC(2026, 0, 1, 12),
      Date.UTC(2026, 0, 1, 13),
    ])
  })

  it('starts daily buckets at midnight UTC', () => {
    const even = buckets(Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 3), 'day')
    expect(even).toEqual([Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2), Date.UTC(2026, 0, 3)])
    const odd = buckets(Date.UTC(2026, 0, 1, 18), Date.UTC(2026, 0, 4, 6), 'day')
    expect(odd).toEqual([Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2), Date.UTC(2026, 0, 3), Date.UTC(2026, 0, 4)])
    expect(buckets(Date.UTC(2026, 0, 2), Date.UTC(2026, 0, 1), 'day')).toEqual([])
  })

  it('fills sparse rows with zeros, a series per level, most severe first', () => {
    const days = ['2026-01-01', '2026-01-02', '2026-01-03']
    expect(
      fill(
        [
          { day: '2026-01-03', level: 'info', count: 4 },
          { day: '2026-01-01', level: 'error', count: 2 },
          { day: '2026-01-03', level: 'error', count: 1 },
          { day: '2026-01-02', level: 'fatal', count: 5 },
          { day: '2026-01-02', level: 'custom', count: 3 },
          { day: '2025-12-31', level: 'debug', count: 9 },
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
})
