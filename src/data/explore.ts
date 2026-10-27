// Explore: events one by one across issues, for a search in Sentry's syntax (`eventFilter`), as a table with the
// columns asked for, a chart of a count over time and a group-by on a tag. Also an issue's own event search.
import type { Span } from '../performance/ingest'
import { eventFilter, matchAny } from '../search/query'
import { hashUser } from '../search/user'
import { buckets, intervalFor, SIZE } from './charts'
import { RANGES, type Range } from './logs'

/** The columns an event always has; any other column is a tag */
export const BUILT_IN = ['level', 'release', 'environment', 'project'] as const
export const DEFAULT_COLUMNS = ['level', 'release', 'environment']
export const MAX_COLUMNS = 6
export const AGGREGATES = ['count', 'count_unique(user)'] as const
export type ExploreAggregate = (typeof AGGREGATES)[number]
const PAGE = 50
const GROUPS = 10

const COLUMN_SQL: Record<(typeof BUILT_IN)[number], string> = {
  level: 'e.level',
  release: "COALESCE(e.release, '')",
  environment: "COALESCE(e.environment, '')",
  project: 'p.slug',
}
const isBuiltIn = (c: string): c is (typeof BUILT_IN)[number] => (BUILT_IN as readonly string[]).includes(c)

export type ExploreInput = {
  query: string
  range: Range | 'all' // all: every event kept, for an issue's own search
  projectId?: number // the page's project; `project:` tokens narrow further
  issueId?: number // an issue's own event search
  columns?: string[]
  groupBy?: string
  aggregate?: ExploreAggregate
  before?: number // received, for the page of older events
}

/** The WHERE of a search: the window, the page's project or issue, the search's tokens; every value bound */
export function whereOf(input: ExploreInput, now: number) {
  const f = eventFilter(input.query, now, hashUser)
  const where = ['e.received >= ?', 'e.received < ?', ...f.where]
  const params: unknown[] = [input.range === 'all' ? 0 : now - RANGES[input.range], now + 1, ...f.params]
  if (input.projectId !== undefined) {
    where.push('e.project_id = ?')
    params.push(input.projectId)
  }
  if (input.issueId !== undefined) {
    where.push('e.issue_id = ?')
    params.push(input.issueId)
  }
  if (f.projectSlugs.length) {
    const [sql, slugs] = matchAny('slug', f.projectSlugs)
    where.push(`e.project_id IN (SELECT id FROM projects WHERE ${sql})`)
    params.push(...slugs)
  }
  return { sql: where.join(' AND '), params }
}

/** The SQL of a column for one event: a built-in, or the tag's value (bound) */
function columnSql(column: string, params: unknown[]) {
  if (isBuiltIn(column)) return COLUMN_SQL[column]
  params.push(column)
  return '(SELECT t.value FROM event_tags t WHERE t.event_id = e.id AND t.key = ?)'
}

export type ExploreRow = {
  id: string
  issue_id: number
  received: number
  title: string
  values: (string | null)[]
}

/** The newest events of a search, a page of 50, with their columns */
export async function exploreEvents(db: D1Database, input: ExploreInput, now: number) {
  const columns = (input.columns?.length ? input.columns : DEFAULT_COLUMNS).slice(0, MAX_COLUMNS)
  const colParams: unknown[] = []
  const cols = columns.map((c, i) => `${columnSql(c, colParams)} AS c${i}`)
  const w = whereOf(input, now)
  const before = input.before !== undefined ? ' AND e.received < ?' : ''
  const rows = (
    await db
      .prepare(
        `SELECT e.id, e.issue_id, e.received, i.title${cols.map((c) => `, ${c}`).join('')}
         FROM events e JOIN issues i ON i.id = e.issue_id JOIN projects p ON p.id = e.project_id
         WHERE ${w.sql}${before} ORDER BY e.received DESC LIMIT ${PAGE + 1}`,
      )
      .bind(...colParams, ...w.params, ...(input.before !== undefined ? [input.before] : []))
      .all<Record<string, unknown>>()
  ).results
  return {
    columns,
    rows: rows.slice(0, PAGE).map((r): ExploreRow => ({
      id: r.id as string,
      issue_id: r.issue_id as number,
      received: r.received as number,
      title: r.title as string,
      values: columns.map((_, i) => (r[`c${i}`] as string | null) ?? null),
    })),
    older: rows.length > PAGE ? (rows[PAGE - 1].received as number) : null,
  }
}

const aggregateSql = (a: ExploreAggregate = 'count') => (a === 'count' ? 'COUNT(*)' : 'COUNT(DISTINCT e.user_hash)')

/**
 * The search's count (or users) per bucket of the window, and with `groupBy` the 10 biggest values of a built-in
 * column or a tag, each with its own series; events without the tag aren't in any group
 */
export async function exploreChart(db: D1Database, input: ExploreInput & { range: Range }, now: number) {
  const from = now - RANGES[input.range]
  const interval = intervalFor(RANGES[input.range])
  const size = SIZE[interval]
  const x = buckets(from, now, interval)
  const w = whereOf(input, now)
  const agg = aggregateSql(input.aggregate)
  if (!input.groupBy) {
    const rows = (
      await db
        .prepare(`SELECT e.received - e.received % ${size} AS at, ${agg} AS v FROM events e WHERE ${w.sql} GROUP BY at`)
        .bind(...w.params)
        .all<{ at: number; v: number }>()
    ).results
    const by = new Map(rows.map((r) => [r.at, r.v]))
    return { x, interval, series: [{ key: 'all', values: x.map((at) => by.get(at) ?? 0) }], groups: [] }
  }
  const g = input.groupBy
  const join = isBuiltIn(g)
    ? { sql: g === 'project' ? ' JOIN projects p ON p.id = e.project_id' : '', column: COLUMN_SQL[g], params: [] }
    : { sql: ' JOIN event_tags g ON g.event_id = e.id AND g.key = ?', column: 'g.value', params: [g] }
  const groups = (
    await db
      .prepare(
        `SELECT ${join.column} AS value, ${agg} AS v FROM events e${join.sql} WHERE ${w.sql}
         GROUP BY value ORDER BY v DESC, value LIMIT ${GROUPS}`,
      )
      .bind(...join.params, ...w.params)
      .all<{ value: string; v: number }>()
  ).results
  if (!groups.length) return { x, interval, series: [], groups }
  const values = groups.map((r) => r.value)
  const rows = (
    await db
      .prepare(
        `SELECT e.received - e.received % ${size} AS at, ${join.column} AS value, ${agg} AS v FROM events e${join.sql}
         WHERE ${w.sql} AND ${join.column} IN (${values.map(() => '?').join(',')}) GROUP BY at, value`,
      )
      .bind(...join.params, ...w.params, ...values)
      .all<{ at: number; value: string; v: number }>()
  ).results
  const cell = new Map(rows.map((r) => [`${r.at}\n${r.value}`, r.v]))
  return {
    x,
    interval,
    series: values.map((value) => ({ key: value, values: x.map((at) => cell.get(`${at}\n${value}`) ?? 0) })),
    groups,
  }
}

/** Everything crashyard keeps of a trace: its events with their issues, its logs, and its stored transactions */
export async function traceOf(db: D1Database, traceId: string) {
  const [events, logs, transactions] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT e.id, e.issue_id, e.received, e.level, e.release, i.title, i.culprit, i.status, p.slug AS project
         FROM events e JOIN issues i ON i.id = e.issue_id JOIN projects p ON p.id = e.project_id
         WHERE e.trace_id = ? ORDER BY e.received LIMIT 200`,
      )
      .bind(traceId),
    db
      .prepare(
        `SELECT l.id, l.timestamp, l.level, l.body, p.slug AS project FROM logs l JOIN projects p ON p.id = l.project_id
         WHERE l.trace_id = ? ORDER BY l.timestamp LIMIT 500`,
      )
      .bind(traceId),
    db
      .prepare(
        `SELECT t.id, t.name, t.release, t.environment, t.timestamp, t.duration, t.status, t.spans, p.slug AS project
         FROM transaction_examples t JOIN projects p ON p.id = t.project_id WHERE t.trace_id = ? ORDER BY t.timestamp LIMIT 20`,
      )
      .bind(traceId),
  ])
  return {
    events: events.results as {
      id: string
      issue_id: number
      received: number
      level: string
      release: string | null
      title: string
      culprit: string
      status: string
      project: string
    }[],
    logs: logs.results as { id: number; timestamp: number; level: string; body: string; project: string }[],
    transactions: (
      transactions.results as {
        id: string
        name: string
        release: string
        environment: string | null
        timestamp: number
        duration: number
        status: string | null
        spans: string
        project: string
      }[]
    ).map((t) => ({ ...t, spans: JSON.parse(t.spans) as Span[] })),
  }
}
