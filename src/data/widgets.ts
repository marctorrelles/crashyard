// Dashboard widgets, schema v2: a dataset, 1 to 3 queries each with its aggregate, up to 2 fields to group by, a sort,
// a limit, thresholds for a number, or markdown text. Widgets of the first shape (one query, a count, one group-by)
// are upgraded when they're read. What the browser sends is checked field by field before it's stored.
import { percentile } from '../performance/histogram'
import { isVital, VITALS } from '../performance/vitals'
import { filterExample, issueFilter, matchAny, tokenize, unparse } from '../search/query'
import { buckets, intervalFor, LEVELS, scoped, SIZE, slugsOf } from './charts'
import { listIssues } from './issues'
import { conditions as logConditions, GROUP_COLUMNS, logGroups, logsByBucket, spanOf, type Window } from './logs'

export const DATASETS = [
  'issues',
  'events',
  'logs',
  'transactions',
  'sessions',
  'monitors',
  'releases',
  'markdown',
] as const
export type Dataset = (typeof DATASETS)[number]
export type Display = 'number' | 'bar' | 'area' | 'line' | 'table' | 'list' | 'text'
const OVER_TIME: Display[] = ['number', 'bar', 'area', 'line', 'table']
/** What each dataset can be shown as: issues as they are now (a count, the top ones), the rest over time */
export const DISPLAYS: Record<Dataset, readonly Display[]> = {
  issues: ['number', 'list'],
  events: OVER_TIME,
  logs: OVER_TIME,
  transactions: OVER_TIME,
  sessions: OVER_TIME,
  monitors: OVER_TIME,
  releases: ['table', 'bar', 'line'],
  markdown: ['text'],
}

// Aggregates of a field, and the fields each dataset has them of ('attribute': any log attribute)
const FIELD_FNS = ['avg', 'sum', 'min', 'max', 'p50', 'p75', 'p95', 'p99'] as const
type FieldFn = (typeof FIELD_FNS)[number]
export type Aggregate =
  | 'count'
  | 'count_unique(user)'
  | 'failure_rate'
  | 'crash_free_rate'
  | 'crash_free_users'
  | 'uptime'
  | `${FieldFn}(${string})`
const AGGREGATES: Record<Dataset, { plain: Aggregate[]; fns?: readonly FieldFn[]; fields?: string[] }> = {
  issues: { plain: ['count'] },
  events: { plain: ['count', 'count_unique(user)'] },
  logs: { plain: ['count'], fns: FIELD_FNS },
  // A vital (src/performance/vitals.ts) only by its percentiles: its histograms keep no sums
  transactions: {
    plain: ['count', 'failure_rate'],
    fns: ['avg', 'p50', 'p75', 'p95', 'p99'],
    fields: ['duration', ...Object.keys(VITALS)],
  },
  sessions: { plain: ['count', 'crash_free_rate', 'crash_free_users'] },
  monitors: { plain: ['count', 'uptime', 'failure_rate'], fns: FIELD_FNS, fields: ['duration'] },
  releases: { plain: ['count', 'count_unique(user)', 'crash_free_rate'] },
  markdown: { plain: [] },
}

/** The aggregates a dataset offers, for the builder: the plain ones, then each function of each field it names */
export function aggregatesOf(dataset: Dataset): { plain: Aggregate[]; fns: readonly string[]; fields?: string[] } {
  const a = AGGREGATES[dataset]
  return { plain: a.plain, fns: a.fns ?? [], fields: a.fields }
}

/** An aggregate as its function and field: `p95(duration)` is p95 of duration */
export function parseAggregate(a: string): { fn: string; field?: string } {
  const m = /^([a-z0-9_]+)\(([\w.-]{1,60})\)$/.exec(a)
  if (m && FIELD_FNS.includes(m[1] as FieldFn)) return { fn: m[1], field: m[2] }
  return { fn: a }
}

/** Why a dataset can't compute an aggregate, naming what it can; null when it can */
export function aggregateError(dataset: Dataset, aggregate: string): string | null {
  const a = AGGREGATES[dataset]
  const { fn, field } = parseAggregate(aggregate)
  if (field === undefined ? a.plain.includes(fn as Aggregate) : a.fns?.includes(fn as FieldFn)) {
    if (field !== undefined && isVital(field) && !/^p\d\d$/.test(fn))
      return `A vital can show p50, p75, p95 or p99, such as p75(${field}).`
    if (field === undefined || !a.fields || a.fields.includes(field)) return null
  }
  const names: string[] = [...a.plain]
  if (a.fns) {
    const of = a.fields ? a.fields.filter((f) => !isVital(f)).join(' or ') : 'an attribute'
    names.push(`${a.fns.join(', ')} of ${of}${a.fields?.some(isVital) ? ', or p50 to p99 of a vital such as lcp' : ''}`)
  }
  const example = a.fns ? `, such as ${a.fns.at(-2)}(${a.fields?.[0] ?? 'duration'})` : ''
  return `${NAMES[dataset]} can show ${names.slice(0, -1).join(', ')}${names.length > 1 ? ' or ' : ''}${names.at(-1)}${example}.`
}

export const NAMES: Record<Dataset, string> = {
  issues: 'Issues',
  events: 'Issue events',
  logs: 'Logs',
  transactions: 'Transactions',
  sessions: 'Sessions',
  monitors: 'Monitors',
  releases: 'Releases',
  markdown: 'Text',
}

/** What each dataset groups by: a fixed list, or for logs these and any attribute */
export const GROUPS: Record<Dataset, string[]> = {
  issues: [],
  events: ['level', 'project', 'release', 'environment'],
  logs: Object.keys(GROUP_COLUMNS),
  transactions: ['transaction', 'release', 'project'],
  sessions: ['release', 'environment', 'project'],
  monitors: ['monitor', 'status', 'kind', 'project'],
  releases: ['release'],
  markdown: [],
}

/**
 * The keys a dataset's filter takes, for those that read fixed columns; issues, events and logs take their whole
 * search (any other key is a tag or an attribute). The dashboard's filter bar applies a key only where it's known
 */
export const FILTER_KEYS: Partial<Record<Dataset, string[]>> = {
  transactions: ['release', 'transaction'],
  sessions: ['release', 'environment'],
  monitors: ['monitor', 'kind', 'status', 'environment', 'release'],
  releases: ['release', 'environment'],
}

export type WidgetQuery = { query: string; aggregate: Aggregate; label?: string }
export type Thresholds = { warning: number; critical: number; direction: 'above' | 'below' }
export type Widget = {
  id: string // 8 random hex
  title: string // 80 at most
  dataset: Dataset
  display: Display
  queries: WidgetQuery[] // 1 to 3; none for markdown
  groupBy?: string[] // 0 to 2 fields, 60 each
  sort?: { by: 'value' | 'name'; dir: 'asc' | 'desc' }
  limit?: number // groups shown, 1 to 50; 8 when unset
  thresholds?: Thresholds // a number turns amber past warning, red past critical
  text?: string // markdown, 4000 at most
  width: 1 | 2 | 3 // thirds of the grid's row
  // A stored widget that no longer reads as one (`readWidgets`): why, shown in its place until it's removed or redone
  invalid?: string
}
/** The first shape, as stored before 0015 */
export type WidgetV1 = {
  id: string
  title: string
  dataset: 'issues' | 'events' | 'logs'
  query: string
  display: Display
  groupBy?: string
  width: 1 | 2 | 3
}

export const MAX_WIDGETS = 20
export const MAX_QUERIES = 3
const TOP = 8
const LIST = 10

const fail = (why: string): never => {
  throw new Error(why)
}
const string = (v: unknown, name: string, max: number) =>
  typeof v === 'string' && v.length <= max ? v : fail(`A widget’s ${name} can be ${max} characters at most.`)
const finite = (v: unknown, name: string) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fail(`A widget’s ${name} must be a number.`)

/** A widget of the first shape as v2: its query a count, its group-by a list of one; it shows the same */
export function upgradeWidget(v1: WidgetV1): Widget {
  const { query, groupBy, ...rest } = v1
  return {
    ...rest,
    queries: [{ query: query ?? '', aggregate: 'count' }],
    ...(groupBy ? { groupBy: [groupBy] } : {}),
  }
}

/** Why a fixed-column dataset's filter can't be read, or null */
function filterError(dataset: Dataset, query: string): string | null {
  const keys = FILTER_KEYS[dataset]
  if (!keys) return null
  for (const t of tokenize(query))
    if (!t.key || !keys.includes(t.key) || t.op !== ':')
      return `${NAMES[dataset]} can be filtered by ${keys.slice(0, -1).join(', ')} and ${keys.at(-1)}, such as ${filterExample(keys[0])}.`
  return null
}

/** One widget from the browser or the database, checked field by field; keys that aren't a widget's are dropped */
export function parseWidget(w: unknown): Widget {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return fail('A widget must be an object.')
  let o = w as Record<string, unknown>
  if (o.invalid !== undefined) fail('Remove or redo the widgets that can’t be read first.')
  // The first shape: a query and no list of them
  if (!Array.isArray(o.queries) && (typeof o.query === 'string' || o.query === undefined))
    o = upgradeWidget(o as WidgetV1) as unknown as Record<string, unknown>
  const id = typeof o.id === 'string' && /^[0-9a-f]{8}$/.test(o.id) ? o.id : fail('A widget’s id is 8 hex digits.')
  const title = string(o.title, 'title', 80).trim() || fail('A widget needs a title.')
  const dataset = DATASETS.includes(o.dataset as Dataset) ? (o.dataset as Dataset) : fail('A widget needs a dataset.')
  const display = DISPLAYS[dataset].includes(o.display as Display)
    ? (o.display as Display)
    : fail(`A widget of ${dataset} shows as ${DISPLAYS[dataset].join(', ')}.`)
  const width = o.width === 1 || o.width === 2 || o.width === 3 ? o.width : fail('A widget is 1, 2 or 3 thirds wide.')
  const widget: Widget = { id, title, dataset, display, queries: [], width }
  if (dataset === 'markdown') {
    const text = string(o.text ?? '', 'text', 4000)
    if (!text.trim()) fail('A text widget needs some text.')
    return { ...widget, text }
  }
  const queries = Array.isArray(o.queries) ? o.queries : []
  if (queries.length < 1 || queries.length > MAX_QUERIES) fail('A widget has 1 to 3 queries.')
  widget.queries = queries.map((q: unknown): WidgetQuery => {
    if (!q || typeof q !== 'object' || Array.isArray(q)) return fail('A widget’s query must be an object.')
    const r = q as Record<string, unknown>
    const query = string(r.query ?? '', 'query', 1000)
    const aggregate = string(r.aggregate ?? 'count', 'aggregate', 80)
    const error = aggregateError(dataset, aggregate) ?? filterError(dataset, query)
    if (error) fail(error)
    const out: WidgetQuery = { query, aggregate: aggregate as Aggregate }
    const label = r.label === undefined || r.label === null ? '' : string(r.label, 'label', 40).trim()
    if (label) out.label = label
    return out
  })
  if (dataset === 'issues' && display === 'list' && widget.queries.length > 1) fail('A list of issues has one query.')
  const groups = o.groupBy === undefined || o.groupBy === null || o.groupBy === '' ? [] : o.groupBy
  if (!Array.isArray(groups) || groups.length > 2) fail('A widget groups by 2 fields at most.')
  const groupBy = (groups as unknown[]).filter((g) => g !== '' && g !== null)
  if (groupBy.length) {
    if (dataset === 'issues') fail('A widget of issues can’t be grouped.')
    for (const g of groupBy) {
      const field = string(g, 'group-by', 60)
      if (!/^[\w.-]+$/.test(field)) fail('A widget groups by a field name.')
      if (dataset !== 'logs' && !GROUPS[dataset].includes(field))
        fail(`A widget of ${NAMES[dataset].toLowerCase()} groups by ${GROUPS[dataset].join(', ')}.`)
    }
    if (new Set(groupBy).size !== groupBy.length) fail('A widget groups by each field once.')
    widget.groupBy = groupBy as string[]
  }
  if (o.sort !== undefined && o.sort !== null) {
    const s = o.sort as Record<string, unknown>
    if ((s.by !== 'value' && s.by !== 'name') || (s.dir !== 'asc' && s.dir !== 'desc'))
      fail('A widget sorts by value or name, up or down.')
    widget.sort = { by: s.by as 'value' | 'name', dir: s.dir as 'asc' | 'desc' }
  }
  if (o.limit !== undefined && o.limit !== null) {
    if (!Number.isInteger(o.limit) || (o.limit as number) < 1 || (o.limit as number) > 50)
      fail('A widget shows 1 to 50 groups.')
    widget.limit = o.limit as number
  }
  if (o.thresholds !== undefined && o.thresholds !== null) {
    const t = o.thresholds as Record<string, unknown>
    if (t.direction !== 'above' && t.direction !== 'below') fail('Thresholds are crossed going above or below.')
    widget.thresholds = {
      warning: finite(t.warning, 'warning value'),
      critical: finite(t.critical, 'critical value'),
      direction: t.direction as 'above' | 'below',
    }
  }
  return widget
}

/** Widgets from the browser, checked one by one (20 at most, ids unique) */
export function parseWidgets(json: unknown): Widget[] {
  if (!Array.isArray(json)) return fail('Widgets must be a list.')
  if (json.length > MAX_WIDGETS) return fail(`A dashboard holds ${MAX_WIDGETS} widgets at most.`)
  const ids = new Set<string>()
  return json.map((w) => {
    const widget = parseWidget(w)
    if (ids.has(widget.id)) fail('Two widgets share an id.')
    ids.add(widget.id)
    return widget
  })
}

/**
 * Stored widgets, read one by one so one that no longer checks out (or text that isn't JSON) doesn't keep the
 * dashboard from opening: it stays in its place as an `invalid` placeholder, to remove or redo in edit mode. The
 * first shape is upgraded on the way
 */
export function readWidgets(text: string): Widget[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = [{ invalid: 'The widgets aren’t JSON.' }]
  }
  const list = Array.isArray(json) ? json.slice(0, MAX_WIDGETS) : [{ invalid: 'The widgets aren’t a list.' }]
  const read = list.map((raw: unknown): Widget | string => {
    try {
      return parseWidget(raw)
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
    return { id, title, dataset: 'issues', display: 'number', queries: [], width: 3, invalid }
  })
}

// ---- What a widget shows ----

export type Unit = 'count' | 'percent' | 'ms' | 'number'
/** What a widget shows; a group value `null` is the rest beyond the shown ones, `''` none (a log with no release) */
export type WidgetData =
  | { kind: 'number'; values: { value: number | null; previous: number | null; unit: Unit }[] }
  | {
      kind: 'series'
      x: number[]
      units: Unit[]
      // `query` is the index of the query it's of; `value` the group's first field's value, for drilling in
      series: { query: number; group: (string | null)[]; value: string | null; counts: (number | null)[] }[]
    }
  | {
      kind: 'table'
      fields: string[]
      units: Unit[]
      rows: { group: (string | null)[]; values: (number | null)[]; previous: (number | null)[] }[]
    }
  | {
      kind: 'list'
      issues: { id: number; title: string; culprit: string; project: string; count: number; level: string }[]
    }
  | { kind: 'text'; text: string }
  | { kind: 'error'; message: string }

/** The unit an aggregate's value is in */
export function unitOf(aggregate: string): Unit {
  const { fn, field } = parseAggregate(aggregate)
  if (fn === 'failure_rate' || fn === 'crash_free_rate' || fn === 'crash_free_users' || fn === 'uptime')
    return 'percent'
  if (field === 'duration') return 'ms'
  if (field !== undefined && isVital(field))
    return VITALS[field].unit === 'ms' ? 'ms' : VITALS[field].unit === 'percent' ? 'percent' : 'number'
  return field === undefined ? 'count' : 'number'
}

/** The dashboard's filter bar: environment, release and a search, laid over every widget whose dataset knows a key */
export type Filters = { environment?: string; release?: string; query?: string }

/** A widget's queries with the filter bar's tokens added, each only where its dataset knows the key */
export function applyFilters(w: Widget, filters: Filters): Widget {
  const tokens = [
    ...(filters.environment ? tokenize(`environment:${JSON.stringify(filters.environment)}`) : []),
    ...(filters.release ? tokenize(`release:${JSON.stringify(filters.release)}`) : []),
    ...tokenize(filters.query ?? ''),
  ]
  if (!tokens.length || w.dataset === 'markdown') return w
  const keys = FILTER_KEYS[w.dataset]
  const known = keys ? tokens.filter((t) => t.key && t.op === ':' && keys.includes(t.key)) : tokens
  if (!known.length) return w
  return { ...w, queries: w.queries.map((q) => ({ ...q, query: unparse([...tokenize(q.query), ...known]) })) }
}

const HOUR = SIZE['1h']
const DAY = SIZE['1d']
const SEP = '\u001f'

// A source of rows, of any dataset: ts (ms), g0 and g1 (the groups, null when not grouped), s (the measure, summed),
// n (how many rows it stands for), e (of those, failed), u (a user, distinct), b (a histogram bucket)
// `scale`: a histogram's values are stored times this (a vital's), so percentiles are divided by it
type Source = { sql: string; params: unknown[]; raw: boolean; histogram?: boolean; scale?: number }
type Span = { from: number; to: number }
type Ctx = { db: D1Database; projectId?: number; now: number }
type Cell = { at: number; key: string | null; v: number | null }

// Conditions over columns from a fixed-key filter (`filterError` passed it)
function columnFilter(query: string, columns: Record<string, string>) {
  const where: string[] = []
  const params: unknown[] = []
  for (const t of tokenize(query)) {
    const column = t.key && columns[t.key]
    if (!column || t.op !== ':') continue
    const [sql, values] = matchAny(column, t.values ?? [t.value])
    where.push(t.negate ? `NOT (${sql})` : sql)
    params.push(...values)
  }
  return { sql: where.map((w) => ` AND ${w}`).join(''), params }
}

const groupCols = (groupBy: string[], columns: Record<string, string>) =>
  [0, 1].map((i) => `${groupBy[i] ? columns[groupBy[i]] : 'NULL'} AS g${i}`).join(', ')

// Events take level, release and environment from their own columns; the rest of the search is the issues'
function splitEventQuery(query: string) {
  const own = ['level', 'release', 'environment']
  const tokens = tokenize(query)
  return {
    issues: unparse(tokens.filter((t) => !(t.key && own.includes(t.key) && t.op === ':'))),
    columns: unparse(tokens.filter((t) => t.key && own.includes(t.key) && t.op === ':')),
  }
}

/** Events per hour from `event_hours`, or each event from `events` for distinct users, of the issues a search matches */
function eventsSource(ctx: Ctx, q: WidgetQuery, groupBy: string[], span: Span): Source {
  const split = splitEventQuery(q.query)
  const f = scoped(issueFilter(split.issues, ctx.now), ctx.projectId)
  const issues = f.where.map((w) => ` AND ${w}`).join('')
  if (q.aggregate === 'count_unique(user)') {
    const cols = {
      level: 'e.level',
      release: "COALESCE(e.release, '')",
      environment: "COALESCE(e.environment, '')",
      project: 'e.project_id',
    }
    const c = columnFilter(split.columns, cols)
    return {
      sql: `SELECT e.received AS ts, ${groupCols(groupBy, cols)}, NULL AS s, 1 AS n, 0 AS e, e.user_hash AS u, NULL AS b
        FROM events e JOIN issues i ON i.id = e.issue_id WHERE e.received >= ? AND e.received < ?${c.sql}${issues}`,
      params: [span.from, span.to, ...c.params, ...f.params],
      raw: true,
    }
  }
  const cols = { level: 'h.level', release: 'h.release', environment: 'h.environment', project: 'h.project_id' }
  const c = columnFilter(split.columns, cols)
  return {
    sql: `SELECT h.hour AS ts, ${groupCols(groupBy, cols)}, NULL AS s, h.count AS n, 0 AS e, NULL AS u, NULL AS b
      FROM event_hours h JOIN issues i ON i.id = h.issue_id WHERE h.hour >= ? AND h.hour < ?${c.sql}${issues}`,
    params: [span.from, span.to, ...c.params, ...f.params],
    raw: false,
  }
}

/** Each log, its measure a numeric attribute from its JSON (the others left out), its groups columns or attributes */
function logsSource(ctx: Ctx, q: WidgetQuery, groupBy: string[], span: Span): Source {
  const cond = logConditions({ query: q.query, projectId: ctx.projectId }, ctx.now)
  const joins: string[] = []
  const keys: string[] = []
  const cols = groupBy.map((g, i) => {
    if (Object.hasOwn(GROUP_COLUMNS, g)) return GROUP_COLUMNS[g]
    joins.push(` JOIN log_attributes a${i} ON a${i}.log_id = l.id AND a${i}.key = ?`)
    keys.push(g)
    return `a${i}.value`
  })
  const groups = [0, 1].map((i) => `${cols[i] ?? 'NULL'} AS g${i}`).join(', ')
  const { field } = parseAggregate(q.aggregate)
  // The field is a name of `[\w.-]` (`parseAggregate`), and bound as the path all the same
  const path = field === undefined ? [] : [`$."${field}"`]
  return {
    sql: `SELECT l.timestamp AS ts, ${groups}, ${path.length ? 'json_extract(l.attributes, ?)' : 'NULL'} AS s, 1 AS n,
      0 AS e, NULL AS u, NULL AS b FROM logs l${joins.join('')} WHERE l.timestamp >= ? AND l.timestamp < ?
      ${path.length ? "AND json_type(l.attributes, ?) IN ('integer', 'real')" : ''}${cond.where.map((w) => ` AND ${w}`).join('')}`,
    params: [...path, ...keys, span.from, span.to, ...path, ...cond.params],
    raw: true,
  }
}

/** Transactions per hour, from `transaction_hours`, or for a percentile their histograms in `transaction_buckets` */
function transactionsSource(ctx: Ctx, q: WidgetQuery, groupBy: string[], span: Span): Source {
  const cols = { transaction: 't.name', release: 't.release', project: 't.project_id' }
  const c = columnFilter(q.query, cols)
  const project = ctx.projectId ? ' AND t.project_id = ?' : ''
  const projectParams = ctx.projectId ? [ctx.projectId] : []
  const histogram = /^p\d\d\(/.test(q.aggregate)
  const { field } = parseAggregate(q.aggregate)
  if (field !== undefined && isVital(field))
    return {
      sql: `SELECT t.hour AS ts, ${groupCols(groupBy, cols)}, NULL AS s, t.count AS n, 0 AS e, NULL AS u, t.bucket AS b
        FROM vital_buckets t WHERE t.vital = ? AND t.hour >= ? AND t.hour < ?${project}${c.sql}`,
      params: [field, span.from, span.to, ...projectParams, ...c.params],
      raw: false,
      histogram: true,
      scale: VITALS[field].scale,
    }
  const sql = histogram
    ? `SELECT t.hour AS ts, ${groupCols(groupBy, cols)}, NULL AS s, t.count AS n, 0 AS e, NULL AS u, t.bucket AS b
       FROM transaction_buckets t WHERE t.hour >= ? AND t.hour < ?${project}${c.sql}`
    : `SELECT t.hour AS ts, ${groupCols(groupBy, cols)}, t.sum_ms AS s, t.count AS n, t.errors AS e, NULL AS u, NULL AS b
       FROM transaction_hours t WHERE t.hour >= ? AND t.hour < ?${project}${c.sql}`
  return { sql, params: [span.from, span.to, ...projectParams, ...c.params], raw: false, histogram }
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** Sessions per UTC day, from `sessions_daily`: every day the span touches */
function sessionsSource(ctx: Ctx, q: WidgetQuery, groupBy: string[], span: Span): Source {
  const cols = { release: 's.release', environment: 's.environment', project: 's.project_id' }
  const c = columnFilter(q.query, cols)
  const project = ctx.projectId ? ' AND s.project_id = ?' : ''
  // Crash-free users: each user's day, crashed or not, counted as distinct hashes
  if (q.aggregate === 'crash_free_users')
    return {
      sql: `SELECT CAST(strftime('%s', s.day) AS INTEGER) * 1000 AS ts, ${groupCols(groupBy, cols)}, NULL AS s,
        1 AS n, s.crashed AS e, s.did_hash AS u, NULL AS b
        FROM session_users_daily s WHERE s.day >= ? AND s.day <= ?${project}${c.sql}`,
      params: [dayOf(span.from), dayOf(span.to - 1), ...(ctx.projectId ? [ctx.projectId] : []), ...c.params],
      raw: false,
    }
  return {
    sql: `SELECT CAST(strftime('%s', s.day) AS INTEGER) * 1000 AS ts, ${groupCols(groupBy, cols)}, NULL AS s,
      s.started AS n, s.crashed AS e, NULL AS u, NULL AS b
      FROM sessions_daily s WHERE s.day >= ? AND s.day <= ?${project}${c.sql}`,
    params: [dayOf(span.from), dayOf(span.to - 1), ...(ctx.projectId ? [ctx.projectId] : []), ...c.params],
    raw: false,
  }
}

/** Finished cron check-ins and uptime results, each one row: its duration, and whether it failed */
function monitorsSource(ctx: Ctx, q: WidgetQuery, groupBy: string[], span: Span): Source {
  const project = ctx.projectId ? ' AND m.project_id = ?' : ''
  const projectParams = ctx.projectId ? [ctx.projectId] : []
  const part = (cols: Record<string, string>, table: string, at: string, rest: string, also = '') => {
    const c = columnFilter(q.query, cols)
    return {
      sql: `SELECT ${at} AS ts, ${groupCols(groupBy, cols)}, ${rest} FROM ${table} JOIN monitors m ON m.id = x.monitor_id
        WHERE ${at} >= ? AND ${at} < ?${also}${project}${c.sql}`,
      params: [span.from, span.to, ...projectParams, ...c.params],
    }
  }
  const common = { monitor: 'm.slug', kind: 'm.kind', project: 'm.project_id' }
  const checkIns = part(
    { ...common, status: 'x.status', environment: 'x.environment', release: 'x.release' },
    'check_ins x',
    'x.started',
    "x.duration AS s, 1 AS n, x.status != 'ok' AS e, NULL AS u, NULL AS b",
    " AND x.status != 'in_progress'",
  )
  // An uptime result has no environment or release: a filter on either leaves them out
  const uptime = part(
    { ...common, status: "CASE x.ok WHEN 1 THEN 'ok' ELSE 'error' END", environment: 'NULL', release: 'NULL' },
    'uptime_results x',
    'x.at',
    'x.ms AS s, 1 AS n, 1 - x.ok AS e, NULL AS u, NULL AS b',
  )
  return { sql: `${checkIns.sql} UNION ALL ${uptime.sql}`, params: [...checkIns.params, ...uptime.params], raw: true }
}

function sourceOf(ctx: Ctx, dataset: Dataset, q: WidgetQuery, groupBy: string[], span: Span): Source {
  switch (dataset) {
    case 'events':
      return eventsSource(ctx, q, groupBy, span)
    case 'logs':
      return logsSource(ctx, q, groupBy, span)
    case 'transactions':
      return transactionsSource(ctx, q, groupBy, span)
    case 'sessions':
      return sessionsSource(ctx, q, groupBy, span)
    case 'monitors':
      return monitorsSource(ctx, q, groupBy, span)
    case 'releases':
      return q.aggregate === 'crash_free_rate'
        ? sessionsSource(ctx, q, groupBy, span)
        : eventsSource(ctx, q, groupBy, span)
    default:
      throw new Error(`${NAMES[dataset]} aren’t read over time.`)
  }
}

/** The SQL of an aggregate over a source's rows, as `v` */
function aggregateSql(aggregate: string): string {
  const { fn } = parseAggregate(aggregate)
  switch (fn) {
    case 'count':
      return 'SUM(n)'
    case 'count_unique(user)':
      // None when there were events and none named a user: not reported, which isn't nobody
      return 'CASE WHEN COUNT(u) = 0 AND SUM(n) > 0 THEN NULL ELSE COUNT(DISTINCT u) END'
    case 'sum':
      return 'SUM(s)'
    case 'avg':
      return 'SUM(s) * 1.0 / NULLIF(SUM(n), 0)'
    case 'min':
      return 'MIN(s)'
    case 'max':
      return 'MAX(s)'
    case 'failure_rate':
      return 'SUM(e) * 100.0 / NULLIF(SUM(n), 0)'
    case 'crash_free_users':
      return '100 - COUNT(DISTINCT CASE WHEN e = 1 THEN u END) * 100.0 / NULLIF(COUNT(DISTINCT u), 0)'
    case 'crash_free_rate':
    case 'uptime':
      return '100 - SUM(e) * 100.0 / NULLIF(SUM(n), 0)'
  }
  throw new Error(`No aggregate ${aggregate}.`)
}

const scaled = (v: number | null, scale = 1) => (v === null ? null : v / scale)

/** A group's key from g0 and g1, or the rest (`null`) when `only` names the groups shown and it isn't one */
const keyOf = (groupBy: string[]) =>
  groupBy.length === 0
    ? "''"
    : groupBy.length === 1
      ? "CAST(COALESCE(g0, '') AS TEXT)"
      : `COALESCE(g0, '') || '${SEP}' || COALESCE(g1, '')`

/**
 * An aggregate over a source per bucket (`size`) or over the whole span (`size` null), per group: the key `null`
 * holds every group not in `only` when it's given. Percentiles are nearest-rank over each row (`raw`), or from a
 * histogram's buckets through `percentile`, as the performance pages
 */
async function compute(
  db: D1Database,
  src: Source,
  aggregate: string,
  groupBy: string[],
  size: number | null,
  only?: string[],
): Promise<Cell[]> {
  const key = keyOf(groupBy)
  const k = only ? `CASE WHEN ${key} IN (SELECT value FROM json_each(?)) THEN ${key} END` : key
  const at = size ? `ts - ts % ${Math.round(size)}` : '0'
  const rows = `WITH src AS (${src.sql}), k AS (SELECT ${at} AS at, ${k} AS k, s, n, e, u, b FROM src)`
  const params = [...src.params, ...(only ? [JSON.stringify(only)] : [])]
  const { fn } = parseAggregate(aggregate)
  const pct = /^p(\d\d)$/.exec(fn)
  if (pct && src.histogram) {
    const found = (
      await db
        .prepare(`${rows} SELECT at, k, b, SUM(n) AS n FROM k GROUP BY at, k, b`)
        .bind(...params)
        .all<{ at: number; k: string | null; b: number; n: number }>()
    ).results
    const cells = Map.groupBy(found, (r) => `${r.at}${SEP}${r.k ?? '\u0000'}`)
    return [...cells.values()].map((group) => ({
      at: group[0].at,
      key: group[0].k,
      v: scaled(percentile(new Map(group.map((r) => [r.b, r.n])), Number(pct[1]) / 100), src.scale),
    }))
  }
  if (pct) {
    if (!src.raw) throw new Error(`${aggregate} needs each row.`)
    // Nearest rank: the smallest value with at least p% of them at or below it
    return (
      await db
        .prepare(
          `${rows} SELECT at, k AS key, s AS v FROM (SELECT at, k, s, ROW_NUMBER() OVER (PARTITION BY at, k ORDER BY s) AS r,
           COUNT(*) OVER (PARTITION BY at, k) AS c FROM k WHERE s IS NOT NULL) WHERE r = MAX(1, (c * ${Number(pct[1])} + 99) / 100)`,
        )
        .bind(...params)
        .all<Cell>()
    ).results
  }
  if ((fn === 'min' || fn === 'max') && !src.raw) throw new Error(`${aggregate} needs each row.`)
  return (
    await db
      .prepare(`${rows} SELECT at, k AS key, ${aggregateSql(aggregate)} AS v FROM k GROUP BY at, k`)
      .bind(...params)
      .all<Cell>()
  ).results
}

/** The buckets a widget charts a span in: logs and monitors as the logs page, hourly rollups by the hour or day */
function intervalOf(w: Widget, span: number) {
  const dataset = w.dataset
  if (dataset === 'sessions' || (dataset === 'releases' && w.queries.some((q) => q.aggregate === 'crash_free_rate')))
    return '1d' as const
  const i = intervalFor(span)
  if (dataset === 'logs' || dataset === 'monitors') return i
  return i === '1d' ? ('1d' as const) : ('1h' as const)
}

/** The span a dataset reads: hourly rollups from the hour that holds `from`, sessions from its day */
function spanFor(dataset: Dataset, aggregate: string, window: Window, now: number): Span {
  const { from, to } = spanOf(window, now)
  const hourly =
    dataset === 'transactions' ||
    ((dataset === 'events' || dataset === 'releases') && aggregate !== 'count_unique(user)')
  if (hourly) return { from: from - (from % HOUR), to }
  if (dataset === 'sessions' || (dataset === 'releases' && aggregate === 'crash_free_rate'))
    return { from: from - (from % DAY), to }
  return { from, to }
}

const additive = (aggregate: string) => ['count', 'sum'].includes(parseAggregate(aggregate).fn)

/** Projects' slugs for a group field `project`, looked up once */
async function labelsOf(db: D1Database, groupBy: string[], keys: (string | null)[]) {
  const at = groupBy.indexOf('project')
  if (at === -1) return (k: string | null) => (k === null ? null : k.split(SEP))
  const ids = [...new Set(keys.flatMap((k) => (k === null ? [] : [Number(k.split(SEP)[at])])))]
  const slugs = ids.length ? await slugsOf(db, ids) : new Map<number, string>()
  return (k: string | null) => {
    if (k === null) return null
    const parts = k.split(SEP)
    parts[at] = slugs.get(Number(parts[at])) ?? parts[at]
    return parts
  }
}

/**
 * The groups to show, from each one's total of the first query: the biggest `limit` (8 unset), or as `sort` says;
 * by level alone, most severe first
 */
function pickGroups(totals: Cell[], w: Widget, groupBy: string[]) {
  const limit = w.limit ?? TOP
  const sorted = [...totals].sort((a, b) => {
    if (!w.sort && groupBy.length === 1 && groupBy[0] === 'level') {
      const rank = (k: string | null) => (LEVELS.includes(k ?? '') ? LEVELS.indexOf(k ?? '') : LEVELS.length)
      return rank(a.key) - rank(b.key) || (b.v ?? 0) - (a.v ?? 0)
    }
    const dir = w.sort?.dir === 'asc' ? 1 : -1
    if (w.sort?.by === 'name') return dir * String(a.key).localeCompare(String(b.key))
    return dir * ((a.v ?? -Infinity) - (b.v ?? -Infinity)) || String(a.key).localeCompare(String(b.key))
  })
  return { shown: sorted.slice(0, limit).map((c) => c.key ?? ''), more: sorted.length > limit }
}

// The default split: one count of events or logs, with no group-by, is split by level (as the first shape was)
export const groupsOf = (w: Widget) =>
  w.groupBy?.length
    ? w.groupBy
    : w.dataset === 'releases'
      ? ['release']
      : (w.dataset === 'events' || w.dataset === 'logs') && w.queries.length === 1 && w.queries[0].aggregate === 'count'
        ? ['level']
        : []

/** A widget over time: a number, a chart or a table, read through `compute` */
async function overTime(ctx: Ctx, w: Widget, window: Window): Promise<WidgetData> {
  const units = w.queries.map((q) => unitOf(q.aggregate))
  const { from, to } = spanOf(window, ctx.now)
  const length = to - from
  if (w.display === 'number') {
    const values = await Promise.all(
      w.queries.map(async (q) => {
        const span = spanFor(w.dataset, q.aggregate, window, ctx.now)
        const before = { from: span.from - length, to: span.from }
        const [now, then] = await Promise.all(
          [span, before].map((s) => compute(ctx.db, sourceOf(ctx, w.dataset, q, [], s), q.aggregate, [], null)),
        )
        const fallback = additive(q.aggregate) ? 0 : null
        return { value: now[0]?.v ?? fallback, previous: then[0]?.v ?? fallback, unit: unitOf(q.aggregate) }
      }),
    )
    return { kind: 'number', values }
  }
  const groupBy = groupsOf(w)
  const first = w.queries[0]
  const firstSpan = spanFor(w.dataset, first.aggregate, window, ctx.now)
  // Every group's total of the first query picks the ones shown; the others are one group, `null`
  const totals = groupBy.length
    ? await compute(ctx.db, sourceOf(ctx, w.dataset, first, groupBy, firstSpan), first.aggregate, groupBy, null)
    : [{ at: 0, key: '', v: null }]
  const { shown, more } = pickGroups(totals, w, groupBy)
  const only = groupBy.length && more ? shown : undefined
  const keys: (string | null)[] = [...shown, ...(only ? [null] : [])]
  const label = await labelsOf(ctx.db, groupBy, keys)

  if (w.display === 'table') {
    const read = await Promise.all(
      w.queries.map(async (q) => {
        const span = spanFor(w.dataset, q.aggregate, window, ctx.now)
        const before = { from: span.from - length, to: span.from }
        return Promise.all(
          [span, before].map((s) =>
            compute(ctx.db, sourceOf(ctx, w.dataset, q, groupBy, s), q.aggregate, groupBy, null, only),
          ),
        )
      }),
    )
    const at = (cells: Cell[], key: string | null) => cells.find((c) => c.key === key)?.v ?? null
    const rows = keys
      .map((key) => ({
        group: label(key) ?? [null],
        values: read.map(([now], i) => at(now, key) ?? (additive(w.queries[i].aggregate) ? 0 : null)),
        previous: read.map(([, then], i) => at(then, key) ?? (additive(w.queries[i].aggregate) ? 0 : null)),
      }))
      // A group with nothing in the window (only in the span before) isn't shown
      .filter((r) => r.values.some((v) => v !== null && v !== 0))
    return { kind: 'table', fields: groupBy.length ? groupBy : [''], units, rows }
  }

  const interval = intervalOf(w, length)
  const size = SIZE[interval]
  const x = buckets(firstSpan.from, to - 1, interval)
  const index = new Map(x.map((at, i) => [at, i]))
  const series = (
    await Promise.all(
      w.queries.map(async (q, qi) => {
        const span = spanFor(w.dataset, q.aggregate, window, ctx.now)
        const cells = await compute(
          ctx.db,
          sourceOf(ctx, w.dataset, q, groupBy, span),
          q.aggregate,
          groupBy,
          size,
          only,
        )
        const fill = additive(q.aggregate) ? 0 : null
        return keys.map((key) => {
          const counts: (number | null)[] = x.map(() => fill)
          for (const c of cells) {
            const i = index.get(c.at)
            if (c.key === key && i !== undefined) counts[i] = c.v
          }
          const group = label(key) ?? [null]
          return { query: qi, group, value: group[0], counts }
        })
      }),
    )
  ).flat()
  return { kind: 'series', x, units, series: series.filter((s) => s.counts.some((v) => v !== null && v !== 0)) }
}

/** Logs counted as the logs page counts them (`log_hours` when it can), for one count and a group-by of one or none */
async function logCounts(ctx: Ctx, w: Widget, window: Window): Promise<WidgetData> {
  const search = { query: w.queries[0].query, projectId: ctx.projectId, window }
  const field = w.groupBy?.[0]
  if (w.display === 'number') {
    const c = await logsByBucket(ctx.db, search, ctx.now)
    const value = c.levels.reduce((a, s) => a + s.counts.reduce((x, y) => x + y, 0), 0)
    return { kind: 'number', values: [{ value, previous: c.previous.reduce((a, b) => a + b, 0), unit: 'count' }] }
  }
  if (w.display === 'table') {
    const g = await logGroups(ctx.db, { ...search, groupBy: field ?? 'level' }, ctx.now)
    return {
      kind: 'table',
      fields: [field ?? 'level'],
      units: ['count'],
      rows: g.groups.map((r) => ({ group: [r.value], values: [r.count], previous: [r.previous] })),
    }
  }
  if (field) {
    const g = await logGroups(ctx.db, { ...search, groupBy: field }, ctx.now)
    return {
      kind: 'series',
      x: g.x,
      units: ['count'],
      series: g.series.map((s) => ({ query: 0, group: [s.value], value: s.value, counts: s.counts })),
    }
  }
  const c = await logsByBucket(ctx.db, search, ctx.now)
  return {
    kind: 'series',
    x: c.x,
    units: ['count'],
    series: c.levels.map((s) => ({ query: 0, group: [s.level], value: s.level, counts: s.counts })),
  }
}

async function issuesData(ctx: Ctx, w: Widget, window: Window): Promise<WidgetData> {
  // Issues as they are now: the window doesn't narrow them (`lastSeen:-24h` in the query does)
  if (w.display === 'number') {
    const values = await Promise.all(
      w.queries.map(async (q) => {
        const f = scoped(issueFilter(q.query, ctx.now), ctx.projectId)
        const row = await ctx.db
          .prepare(
            `SELECT COUNT(*) AS value, COALESCE(SUM(i.first_seen < ?), 0) AS previous FROM issues i
             ${f.where.length ? `WHERE ${f.where.join(' AND ')}` : ''}`,
          )
          .bind(spanOf(window, ctx.now).from, ...f.params)
          .first<{ value: number; previous: number }>()
        // `previous`: the ones there were before the window began, so the change is how many are new since
        return { value: row?.value ?? 0, previous: row?.previous ?? 0, unit: 'count' as const }
      }),
    )
    return { kind: 'number', values }
  }
  const { issues } = await listIssues(
    ctx.db,
    { query: w.queries[0].query, projectId: ctx.projectId, sort: 'events', page: 0 },
    ctx.now,
  )
  return {
    kind: 'list',
    issues: issues.slice(0, w.limit ?? LIST).map((i) => ({
      id: i.id,
      title: i.title,
      culprit: i.culprit,
      project: i.project,
      count: i.count,
      level: i.level,
    })),
  }
}

/** What a widget shows over a window, narrowed to a project and the filter bar; any error is a message to show */
export async function widgetData(
  db: D1Database,
  widget: Widget,
  projectId: number | undefined,
  window: Window,
  now: number,
  filters: Filters = {},
): Promise<WidgetData> {
  if (widget.invalid) return { kind: 'error', message: widget.invalid }
  if (widget.dataset === 'markdown') return { kind: 'text', text: widget.text ?? '' }
  const w = applyFilters(widget, filters)
  const ctx = { db, projectId, now }
  try {
    if (w.dataset === 'issues') return await issuesData(ctx, w, window)
    if (
      w.dataset === 'logs' &&
      w.queries.length === 1 &&
      w.queries[0].aggregate === 'count' &&
      (w.groupBy?.length ?? 0) <= 1 &&
      !w.sort &&
      !w.limit
    )
      return await logCounts(ctx, w, window)
    return await overTime(ctx, w, window)
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : 'This widget couldn’t be read' }
  }
}
