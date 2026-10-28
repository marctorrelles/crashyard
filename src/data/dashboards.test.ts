import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { addWidget, dashboardHistory, getDashboard, revisionWidgets, saveDashboard } from './dashboards'
import { STARTER } from './templates'
import { parseWidgets, readWidgets, upgradeWidget, widgetData } from './widgets'

// A widget as stored before schema v2
const widget = {
  id: '0a1b2c3d',
  title: 'Errors',
  dataset: 'logs',
  query: 'level:error',
  display: 'bar',
  groupBy: 'release',
  width: 2,
} as const
const upgraded = upgradeWidget(widget)

describe('parseWidgets', () => {
  it('accepts a valid widget of either shape, and the starter dashboard', () => {
    expect(parseWidgets([widget])).toEqual([upgraded])
    expect(parseWidgets([upgraded])).toEqual([upgraded])
    expect(parseWidgets(STARTER.widgets)).toEqual(STARTER.widgets)
  })

  it('strips keys that are not a widget’s, and an empty group-by', () => {
    expect(parseWidgets([{ ...widget, sql: 'DROP TABLE logs', extra: 1 }])).toEqual([upgraded])
    const { groupBy: _, ...plain } = upgraded
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
    ['an events group-by it has not', { dataset: 'events', groupBy: 'song' }],
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
    expect(read[0]).toEqual(upgraded)
    expect(read[2]).toEqual(upgradeWidget(other))
    expect(read[1]).toMatchObject({ id: '00000000', title: 'Pie', invalid: expect.stringContaining('shows as') })
    // Its data is the reason, without a read
    expect(await widgetData({} as D1Database, read[1], undefined, { range: '24h' }, 0)).toEqual({
      kind: 'error',
      message: read[1].invalid,
    })
  })

  it('opens text that is not JSON, or not a list, as one placeholder; a repeated id gets a free one', () => {
    expect(readWidgets('{oops')).toEqual([
      expect.objectContaining({ title: 'A widget', invalid: 'The widgets aren’t JSON.' }),
    ])
    expect(readWidgets('{}')).toEqual([expect.objectContaining({ invalid: 'The widgets aren’t a list.' })])
    const twice = readWidgets(JSON.stringify([widget, widget]))
    expect(twice.map((w) => w.id)).toEqual([widget.id, '00000000'])
    expect(twice[1].invalid).toBeDefined()
  })

  it('saves no placeholder: it has to be removed or redone first', () => {
    const [placeholder] = readWidgets('{oops')
    expect(() => parseWidgets([placeholder])).toThrow(/Remove or redo/)
  })
})

describe('revisions', () => {
  it('keeps the widget lists of the last 10 saves, newest first, and restores one as it was', async () => {
    const db = sqliteD1()
    // A dashboard as stored before 0015: widgets of the first shape
    db.sqlite.exec(`INSERT INTO dashboards (id, name, widgets, updated, updated_by)
      VALUES (1, 'Crashes', '${JSON.stringify([widget])}', 100, 'marc@example.com')`)
    expect((await getDashboard(db, 1))?.widgets).toEqual([upgraded])
    for (let i = 1; i <= 12; i++)
      await saveDashboard(
        db,
        { id: 1, name: 'Crashes', widgets: [{ ...upgraded, title: `Errors ${i}` }] },
        `p${i}@example.com`,
        100 + i,
      )
    // A save that changes no widget adds none
    await saveDashboard(db, { id: 1, name: 'Renamed', widgets: [{ ...upgraded, title: 'Errors 12' }] }, 'x', 200)
    const history = await dashboardHistory(db, 1)
    expect(history).toHaveLength(10)
    expect(history[0]).toEqual({ index: 0, by: 'p11@example.com', at: 111, widgets: 1 })
    expect((await revisionWidgets(db, 1, 0))[0].title).toBe('Errors 11')
    // The oldest kept is the tenth before the last
    expect((await revisionWidgets(db, 1, 9))[0].title).toBe('Errors 2')
    await expect(revisionWidgets(db, 1, 10)).rejects.toThrow('no longer kept')
  })

  it('reads a v1 revision as v2, and adds a widget at the end', async () => {
    const db = sqliteD1()
    db.sqlite.exec(`INSERT INTO dashboards (id, name, widgets, updated, updated_by)
      VALUES (1, 'Crashes', '${JSON.stringify([widget])}', 100, 'marc@example.com')`)
    await addWidget(db, 1, { ...upgraded, id: '00000009', title: 'More' }, 'marc@example.com', 200)
    expect((await getDashboard(db, 1))?.widgets.map((w) => w.title)).toEqual(['Errors', 'More'])
    expect(await revisionWidgets(db, 1, 0)).toEqual([upgraded])
    await expect(addWidget(db, 1, upgraded, 'm', 300)).rejects.toThrow('share an id')
  })

  it('never writes over a save made since the version a change was made on', async () => {
    const db = sqliteD1()
    db.sqlite.exec(`INSERT INTO dashboards (id, name, widgets, updated, updated_by)
      VALUES (1, 'Crashes', '${JSON.stringify([widget])}', 100, 'marc@example.com')`)
    await saveDashboard(db, { id: 1, name: 'Crashes', widgets: [{ ...upgraded, title: 'Theirs' }] }, 'ana', 150)
    const stale = saveDashboard(db, { id: 1, name: 'Crashes', widgets: [upgraded] }, 'marc', 160, 100)
    await expect(stale).rejects.toThrow('Someone saved this dashboard just now')
    // Adding a widget reads the dashboard as it is now, so their save stays
    await addWidget(db, 1, { ...upgraded, id: '00000009', title: 'More' }, 'marc', 170)
    expect((await getDashboard(db, 1))?.widgets.map((w) => w.title)).toEqual(['Theirs', 'More'])
  })
})
