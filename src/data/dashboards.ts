// Dashboards: a name and its widgets, each a search over issues, their events or logs, shown as a number, a chart, a
// table or a list. Widgets come from the browser as JSON, so `parseWidgets` checks every field before they're stored.
import { issueFilter } from '../search/query'
import { EVENT_GROUPS, type EventGroup, fill, issueEventsByDay, scoped, topWithOther } from './charts'
import { listIssues } from './issues'
import { logGroups, logsByBucket, spanOf, type Window } from './logs'
import { lastDays } from './projects'

export const DATASETS = ['issues', 'events', 'logs'] as const
export type Dataset = (typeof DATASETS)[number]
export type Display = 'number' | 'bar' | 'area' | 'line' | 'table' | 'list'
// What each dataset can be shown as: issues as they are now (a count, the top ones), events and logs over time
export const DISPLAYS: Record<Dataset, readonly Display[]> = {
  issues: ['number', 'list'],
  events: ['number', 'bar', 'area', 'line', 'table'],
  logs: ['number', 'bar', 'area', 'line', 'table'],
}
export const MAX_WIDGETS = 20
const TOP = 8
const LIST = 10

export type Widget = {
  id: string // 8 random hex
  title: string // 80 at most
  dataset: Dataset
  query: string // 1000 at most, the search's grammar
  display: Display
  groupBy?: string // 60 at most; events: level or project; logs: a column or an attribute
  width: 1 | 2 | 3 // thirds of the grid's row
  // A stored widget that no longer reads as one (`readWidgets`): why, shown in its place until it's removed or redone
  invalid?: string
}
export type Dashboard = { id: number; name: string; widgets: Widget[]; updated: number; updated_by: string }

/** What a widget shows; a value `null` is the rest beyond the top 8, `''` none (a log with no release) */
export type WidgetData =
  | { kind: 'number'; value: number; previous: number }
  | { kind: 'series'; x: number[]; series: { value: string | null; counts: number[] }[] }
  | { kind: 'table'; rows: { value: string | null; count: number; previous: number }[] }
  | {
      kind: 'list'
      issues: { id: number; title: string; culprit: string; project: string; count: number; level: string }[]
    }
  | { kind: 'error'; message: string }

const fail = (why: string): never => {
  throw new Error(`a widget ${why}`)
}
const string = (v: unknown, name: string, max: number) =>
  typeof v === 'string' && v.length <= max ? v : fail(`needs a ${name} of ${max} characters at most`)

/** Widgets from the browser, checked field by field (20 at most, ids unique); keys that aren't a widget's are dropped */
export function parseWidgets(json: unknown): Widget[] {
  if (!Array.isArray(json)) return fail('list must be a list')
  if (json.length > MAX_WIDGETS) return fail(`list holds ${MAX_WIDGETS} at most`)
  const ids = new Set<string>()
  return json.map((w: unknown): Widget => {
    if (!w || typeof w !== 'object' || Array.isArray(w)) return fail('must be an object')
    const o = w as Record<string, unknown>
    if (o.invalid !== undefined) fail('that couldn’t be read must be removed or redone first')
    const id = typeof o.id === 'string' && /^[0-9a-f]{8}$/.test(o.id) ? o.id : fail('id is 8 hex digits')
    if (ids.has(id)) fail('id is used twice')
    ids.add(id)
    const title = string(o.title, 'title', 80).trim() || fail('needs a title')
    const dataset = DATASETS.includes(o.dataset as Dataset) ? (o.dataset as Dataset) : fail('needs a dataset')
    const display = DISPLAYS[dataset].includes(o.display as Display)
      ? (o.display as Display)
      : fail(`of ${dataset} is shown as ${DISPLAYS[dataset].join(', ')}`)
    const query = string(o.query ?? '', 'query', 1000)
    const width = o.width === 1 || o.width === 2 || o.width === 3 ? o.width : fail('is 1, 2 or 3 thirds wide')
    const widget: Widget = { id, title, dataset, query, display, width }
    if (o.groupBy !== undefined && o.groupBy !== null && o.groupBy !== '') {
      const groupBy = string(o.groupBy, 'group-by', 60)
      if (dataset === 'issues') fail('of issues has no group-by')
      if (dataset === 'events' && !Object.hasOwn(EVENT_GROUPS, groupBy)) fail('of events groups by level or project')
      if (!/^[\w.-]+$/.test(groupBy)) fail('groups by a field name')
      widget.groupBy = groupBy
    }
    return widget
  })
}

/** A dashboard to start from: what crashed, how much, and which releases log errors */
export const STARTER: { name: string; widgets: Widget[] } = {
  name: 'Crashes',
  widgets: [
    { id: '0e7e4751', title: 'Events', dataset: 'events', query: '', display: 'number', width: 1 },
    { id: '1b0a6c2f', title: 'Events by level', dataset: 'events', query: '', display: 'bar', width: 2 },
    {
      id: '2c4d9e10',
      title: 'Top unresolved issues',
      dataset: 'issues',
      query: 'is:unresolved',
      display: 'list',
      width: 2,
    },
    {
      id: '3f8b2a7d',
      title: 'Log errors by release',
      dataset: 'logs',
      query: 'level:error',
      display: 'table',
      groupBy: 'release',
      width: 1,
    },
  ],
}

/**
 * Stored widgets, read one by one so one that no longer checks out (or text that isn't JSON) doesn't keep the
 * dashboard from opening: it stays in its place as an `invalid` placeholder, to remove or redo in edit mode
 */
export function readWidgets(text: string): Widget[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = [{ invalid: 'the widgets aren’t JSON' }]
  }
  const list = Array.isArray(json) ? json.slice(0, MAX_WIDGETS) : [{ invalid: 'the widgets aren’t a list' }]
  const read = list.map((raw: unknown): Widget | string => {
    try {
      return parseWidgets([raw])[0]
    } catch (error) {
      const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      if (typeof o.invalid === 'string') return o.invalid
      return error instanceof Error ? error.message : 'This widget couldn’t be read'
    }
  })
  // Ids stay unique: a repeated one, or a placeholder's, gets the next one free
  const ids = new Set<string>()
  const free = () => {
    let n = 0
    while (ids.has(n.toString(16).padStart(8, '0'))) n++
    return n.toString(16).padStart(8, '0')
  }
  return read.map((w, i) => {
    if (typeof w !== 'string' && !ids.has(w.id)) {
      ids.add(w.id)
      return w
    }
    const raw = list[i] && typeof list[i] === 'object' ? (list[i] as Record<string, unknown>) : {}
    const id = free()
    ids.add(id)
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 80) : 'A widget'
    const invalid = typeof w === 'string' ? w : 'a widget id is used twice'
    return { id, title, dataset: 'issues', query: '', display: 'number', width: 3, invalid }
  })
}

export async function listDashboards(db: D1Database) {
  return (
    await db
      .prepare(
        `SELECT id, name, CASE WHEN json_valid(widgets) THEN json_array_length(widgets) END AS widgets, updated,
         updated_by FROM dashboards ORDER BY updated DESC`,
      )
      .all<{ id: number; name: string; widgets: number | null; updated: number; updated_by: string }>()
  ).results
}

export async function getDashboard(db: D1Database, id: number): Promise<Dashboard | null> {
  const row = await db
    .prepare('SELECT id, name, widgets, updated, updated_by FROM dashboards WHERE id = ?')
    .bind(id)
    .first<Omit<Dashboard, 'widgets'> & { widgets: string }>()
  return row && { ...row, widgets: readWidgets(row.widgets) }
}

/** A new dashboard (no `id`) or a whole one written over; its id */
export async function saveDashboard(
  db: D1Database,
  d: { id?: number; name: string; widgets: Widget[] },
  by: string,
  now: number,
) {
  const widgets = JSON.stringify(d.widgets)
  const row =
    d.id === undefined
      ? await db
          .prepare('INSERT INTO dashboards (name, widgets, updated, updated_by) VALUES (?, ?, ?, ?) RETURNING id')
          .bind(d.name, widgets, now, by)
          .first<{ id: number }>()
      : await db
          .prepare('UPDATE dashboards SET name = ?, widgets = ?, updated = ?, updated_by = ? WHERE id = ? RETURNING id')
          .bind(d.name, widgets, now, by, d.id)
          .first<{ id: number }>()
  if (!row) throw new Error('that dashboard is gone')
  return row.id
}

export async function deleteDashboard(db: D1Database, id: number) {
  await db.prepare('DELETE FROM dashboards WHERE id = ?').bind(id).run()
}

const DAY = 864e5
/**
 * The UTC days an events widget reads (`issue_days` is per day): every day the window touches, `min` at least (a
 * chart has a week to show), 90 at most; and as many days just before them
 */
export function eventDays(window: Window, now: number, min: number) {
  const { from, to } = spanOf(window, now)
  const touched = Math.floor((to - 1) / DAY) - Math.floor(from / DAY) + 1
  const n = Math.min(90, Math.max(min, touched))
  return { days: lastDays(n, to - 1), before: lastDays(n, to - 1 - n * DAY) }
}

const sum = (counts: number[]) => counts.reduce((a, b) => a + b, 0)

/** The top 8 rows by count, the rest as one row whose value is `null` */
function topRows(rows: { value: string; count: number; previous: number }[]) {
  const sorted = [...rows].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
  const top: { value: string | null; count: number; previous: number }[] = sorted.slice(0, TOP)
  const rest = sorted.slice(TOP)
  if (rest.length)
    top.push({ value: null, count: sum(rest.map((r) => r.count)), previous: sum(rest.map((r) => r.previous)) })
  return top
}

async function eventsData(db: D1Database, w: Widget, projectId: number | undefined, window: Window, now: number) {
  const filter = issueFilter(w.query, now)
  const by = (w.groupBy ?? 'level') as EventGroup
  if (w.display === 'number' || w.display === 'table') {
    const { days, before } = eventDays(window, now, 1)
    const rows = await issueEventsByDay(db, filter, projectId, [...before, ...days], by)
    const current = fill(rows, days)
    const previous = new Map(fill(rows, before).map((s) => [s.level, sum(s.counts)]))
    if (w.display === 'number')
      return {
        kind: 'number' as const,
        value: sum(current.map((s) => sum(s.counts))),
        previous: sum([...previous.values()]),
      }
    return {
      kind: 'table' as const,
      rows: topRows(
        current.map((s) => ({ value: s.level, count: sum(s.counts), previous: previous.get(s.level) ?? 0 })),
      ).filter((r) => r.count > 0),
    }
  }
  const { days } = eventDays(window, now, 7)
  const series = fill(await issueEventsByDay(db, filter, projectId, days, by), days).map((s) => ({
    value: s.level,
    counts: s.counts,
  }))
  return {
    kind: 'series' as const,
    x: days.map((d) => Date.parse(`${d}T00:00:00Z`)),
    // Levels are few and in order of severity; projects the 8 with most and the rest
    series: by === 'level' ? series : topWithOther(series, TOP),
  }
}

async function logsData(db: D1Database, w: Widget, projectId: number | undefined, window: Window, now: number) {
  const search = { query: w.query, projectId, window }
  if (w.display === 'number') {
    const c = await logsByBucket(db, search, now)
    return { kind: 'number' as const, value: sum(c.levels.map((s) => sum(s.counts))), previous: sum(c.previous) }
  }
  if (w.display === 'table')
    return {
      kind: 'table' as const,
      rows: (await logGroups(db, { ...search, groupBy: w.groupBy ?? 'level' }, now)).groups,
    }
  if (w.groupBy) {
    const g = await logGroups(db, { ...search, groupBy: w.groupBy }, now)
    return { kind: 'series' as const, x: g.x, series: g.series }
  }
  const c = await logsByBucket(db, search, now)
  return { kind: 'series' as const, x: c.x, series: c.levels.map((s) => ({ value: s.level, counts: s.counts })) }
}

async function issuesData(db: D1Database, w: Widget, projectId: number | undefined, window: Window, now: number) {
  // Issues as they are now: the window doesn't narrow them (`lastSeen:-24h` in the query does)
  if (w.display === 'number') {
    const f = scoped(issueFilter(w.query, now), projectId)
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS value, COALESCE(SUM(i.first_seen < ?), 0) AS previous FROM issues i
         ${f.where.length ? `WHERE ${f.where.join(' AND ')}` : ''}`,
      )
      .bind(spanOf(window, now).from, ...f.params)
      .first<{ value: number; previous: number }>()
    // `previous`: the ones there were before the window began, so the change is how many are new since
    return { kind: 'number' as const, value: row?.value ?? 0, previous: row?.previous ?? 0 }
  }
  const { issues } = await listIssues(db, { query: w.query, projectId, sort: 'events', page: 0 }, now)
  return {
    kind: 'list' as const,
    issues: issues.slice(0, LIST).map((i) => ({
      id: i.id,
      title: i.title,
      culprit: i.culprit,
      project: i.project,
      count: i.count,
      level: i.level,
    })),
  }
}

/** What a widget shows over a window, narrowed to a project; a search the database refuses is an error to show */
export async function widgetData(
  db: D1Database,
  w: Widget,
  projectId: number | undefined,
  window: Window,
  now: number,
): Promise<WidgetData> {
  if (w.invalid) return { kind: 'error', message: w.invalid }
  try {
    if (w.dataset === 'events') return await eventsData(db, w, projectId, window, now)
    if (w.dataset === 'logs') return await logsData(db, w, projectId, window, now)
    return await issuesData(db, w, projectId, window, now)
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : 'This widget couldn’t be read' }
  }
}
