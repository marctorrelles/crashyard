import { describe, expect, it } from 'vitest'
import { eventDays, parseWidgets, readWidgets, STARTER, widgetData } from './dashboards'

const widget = {
  id: '0a1b2c3d',
  title: 'Errors',
  dataset: 'logs',
  query: 'level:error',
  display: 'bar',
  groupBy: 'release',
  width: 2,
}

describe('parseWidgets', () => {
  it('accepts a valid widget, and the starter dashboard', () => {
    expect(parseWidgets([widget])).toEqual([widget])
    expect(parseWidgets(STARTER.widgets)).toEqual(STARTER.widgets)
  })

  it('strips keys that are not a widget’s, and an empty group-by', () => {
    expect(parseWidgets([{ ...widget, sql: 'DROP TABLE logs', extra: 1 }])).toEqual([widget])
    const { groupBy: _, ...plain } = widget
    expect(parseWidgets([{ ...widget, groupBy: '' }])).toEqual([plain])
  })

  it.each([
    ['an unknown dataset', { dataset: 'users' }],
    ['an unknown display', { display: 'pie' }],
    ['a display its dataset has not', { dataset: 'issues', display: 'bar', groupBy: undefined }],
    ['a title over 80', { title: 'x'.repeat(81) }],
    ['an empty title', { title: '  ' }],
    ['a query over 1000', { query: 'x'.repeat(1001) }],
    ['a query that is not text', { query: 42 }],
    ['an id that is not 8 hex', { id: '0A1B2C3D' }],
    ['a short id', { id: 'abc' }],
    ['a width of 4', { width: 4 }],
    ['a width as text', { width: '2' }],
    ['a group-by over 60', { groupBy: 'x'.repeat(61) }],
    ['a group-by that is no field', { groupBy: 'a b' }],
    ['an events group-by that is not level or project', { dataset: 'events', groupBy: 'release' }],
    ['a group-by on issues', { dataset: 'issues', display: 'list' }],
  ])('rejects %s', (_, change) => {
    expect(() => parseWidgets([{ ...widget, ...change }])).toThrow()
  })

  it('rejects a non-array, a non-object widget, a repeated id and 21 widgets', () => {
    expect(() => parseWidgets({ widgets: [] })).toThrow()
    expect(() => parseWidgets('[]')).toThrow()
    expect(() => parseWidgets([null])).toThrow()
    expect(() => parseWidgets([[widget]])).toThrow()
    expect(() => parseWidgets([widget, widget])).toThrow()
    const many = Array.from({ length: 21 }, (_, i) => ({ ...widget, id: i.toString(16).padStart(8, '0') }))
    expect(() => parseWidgets(many)).toThrow()
    expect(parseWidgets(many.slice(0, 20))).toHaveLength(20)
  })
})

describe('readWidgets', () => {
  it('keeps the valid widgets and puts a placeholder where one no longer reads', async () => {
    const other = { ...widget, id: '00000001', title: 'Warnings' }
    const read = readWidgets(JSON.stringify([widget, { ...widget, display: 'pie', title: 'Pie' }, other]))
    expect(read[0]).toEqual(widget)
    expect(read[2]).toEqual(other)
    expect(read[1]).toMatchObject({ id: '00000000', title: 'Pie', invalid: expect.stringContaining('shown as') })
    // Its data is the reason, without a read
    expect(await widgetData({} as D1Database, read[1], undefined, { range: '24h' }, 0)).toEqual({
      kind: 'error',
      message: read[1].invalid,
    })
  })

  it('opens text that is not JSON, or not a list, as one placeholder; a repeated id gets a free one', () => {
    expect(readWidgets('{oops')).toEqual([
      expect.objectContaining({ title: 'A widget', invalid: 'the widgets aren’t JSON' }),
    ])
    expect(readWidgets('{}')).toEqual([expect.objectContaining({ invalid: 'the widgets aren’t a list' })])
    const twice = readWidgets(JSON.stringify([widget, widget]))
    expect(twice.map((w) => w.id)).toEqual([widget.id, '00000000'])
    expect(twice[1].invalid).toBeDefined()
  })

  it('saves no placeholder: it has to be removed or redone first', () => {
    const [placeholder] = readWidgets('{oops')
    expect(() => parseWidgets([placeholder])).toThrow(/removed or redone/)
  })
})

describe('eventDays', () => {
  const now = Date.UTC(2026, 9, 26, 15)
  it('reads a week at least for a chart, and the days the window touches for a number', () => {
    const chart = eventDays({ range: '24h' }, now, 7)
    expect(chart.days).toHaveLength(7)
    expect(chart.days.at(-1)).toBe('2026-10-26')
    expect(chart.before.at(-1)).toBe('2026-10-19')
    expect(eventDays({ range: '24h' }, now, 1).days).toEqual(['2026-10-25', '2026-10-26'])
    expect(eventDays({ range: '30d' }, now, 7).days).toHaveLength(31)
  })

  it('ends an exact span on the day of its last moment', () => {
    const w = { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 3) }
    expect(eventDays(w, now, 1)).toEqual({ days: ['2026-10-01', '2026-10-02'], before: ['2026-09-29', '2026-09-30'] })
  })
})
