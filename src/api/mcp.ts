// POST /mcp: an MCP server (Streamable HTTP, answering with JSON), so an agent can read what the dashboard shows,
// projects, issues and their events, logs, traces, releases, performance, monitors and status pages, and triage issues
// and post to status pages. Agents sign in with their person's agent token (Settings, Agent tokens), as
// `Authorization: Bearer`, and change things only when its scope and that person's role allow it. See docs/mcp.md.
import { exploreChart, exploreEvents, traceOf, whereOf } from '../data/explore'
import * as issues from '../data/issues'
import { suspectCommits } from '../data/suspects'
import { listLogs, RANGES, type Range } from '../data/logs'
import { getMonitor, listMonitors } from '../data/monitors'
import { overview, projectBySlug } from '../data/projects'
import { transaction, transactions } from '../data/performance'
import { type Role, reaches } from '../data/people'
import { deploysOf, listReleases, releaseDiff, releaseHealth } from '../data/releases'
import { releaseCommits } from '../data/source'
import * as status from '../data/status'
import type { NormalizedEvent } from '../ingest/event'
import { PRIORITIES, type Priority } from '../ingest/priority'
import favicon from '../favicon.svg?url'
import { version } from '../../package.json'

const VERSION = '2025-06-18'

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> }
type Tool = {
  name: string
  changes?: true // resolves, ignores or notes: refused for agents unless Settings, Tokens lets them
  description: string
  inputSchema: Record<string, unknown>
  run: (
    args: Record<string, unknown>,
    ctx: { db: D1Database; viewer: string; role: Role; origin: string },
  ) => Promise<string>
}

const string = (description: string) => ({ type: 'string', description })
const integer = (description: string) => ({ type: 'integer', description })
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
})

const argString = (v: unknown, max = 1000) => (typeof v === 'string' ? v.slice(0, max) : undefined)
const argInt = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined)
const need = <T>(v: T | undefined, name: string): T => {
  if (v === undefined) throw new Error(`${name} is required`)
  return v
}
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T) =>
  values.includes(v as T) ? (v as T) : fallback
/** `ids`, else `id`, as issue ids; 100 at most */
const issueIds = (a: Record<string, unknown>) => {
  const list = Array.isArray(a.ids) ? a.ids.map(argInt) : [argInt(a.id)]
  const ids = list.filter((i): i is number => i !== undefined).slice(0, 100)
  if (!ids.length) throw new Error('id or ids is required')
  return ids
}
const idOrIds = {
  id: integer('issue id'),
  ids: { type: 'array', items: { type: 'integer' }, description: 'several issue ids, instead of id' },
}

async function projectId(db: D1Database, slug: unknown) {
  const s = argString(slug, 60)
  if (!s) return undefined
  return (await projectBySlug(db, s))?.id ?? -1
}

/** A project by its slug, which the tool needs; an error naming it when there's none */
async function needProject(db: D1Database, slug: unknown) {
  const s = need(argString(slug, 60), 'project')
  const project = await projectBySlug(db, s)
  if (!project) throw new Error(`No project ${s}. list_projects names them.`)
  return project
}

const when = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(1)}%`)
const ms = (x: number | null | undefined) => (x === null || x === undefined ? '-' : `${Math.round(x)} ms`)
const DAYS = ['1', '7', '30'] as const

/** An issue as text an agent reads well: the header, counts, top tags, the latest event's stack and breadcrumbs */
function issueText(d: NonNullable<Awaited<ReturnType<typeof issues.getIssue>>>, origin: string) {
  const i = d.issue
  const lines = [
    `# ${i.title}`,
    `${origin}/issues/${i.id} · project ${i.project} · ${i.status}${i.substatus ? ` (${i.substatus})` : ''} · level ${i.level}`,
    `culprit: ${i.culprit || '-'}`,
    `${i.count} events, ${i.user_count} users · first seen ${when(i.first_seen)}${i.first_release ? ` in ${i.first_release}` : ''} · last seen ${when(i.last_seen)}${i.last_release ? ` in ${i.last_release}` : ''}`,
  ]
  // When it happens: events per UTC day over the last 14, the days with none left out
  const recent = d.days.slice(-14).flatMap((day, i) => {
    const n = d.series[d.series.length - 14 + i]
    return n ? [`${day.slice(5)} ${n}`] : []
  })
  lines.push(`events per day, last 14: ${recent.length ? recent.join(', ') : 'none'}`)
  const byKey = Map.groupBy(d.tags, (t) => t.key)
  if (byKey.size) {
    lines.push('', '## Tags')
    for (const [key, values] of byKey)
      lines.push(`- ${key}: ${values.map((v) => `${v.value} (${Math.round((v.count / v.total) * 100)}%)`).join(', ')}`)
  }
  const event = d.eventJson ? (JSON.parse(d.eventJson) as NormalizedEvent) : null
  if (event) {
    lines.push(
      '',
      `## Latest event ${event.id} · ${when(event.timestamp)}${event.release ? ` · ${event.release}` : ''}${event.environment ? ` · ${event.environment}` : ''}`,
    )
    for (const e of [...event.exceptions].reverse()) {
      lines.push(
        '',
        `${e.type}: ${e.value}${e.handled === false ? ' (not handled)' : ''}`,
        'Stack, most recent call first (* = app code):',
      )
      for (const f of [...e.frames].reverse().slice(0, 40)) {
        const where = [f.filename ?? f.module, f.lineno, f.colno].filter((x) => x !== undefined).join(':')
        lines.push(
          `${f.inApp ? '*' : ' '} ${f.function ?? f.instructionAddr ?? '?'}${where ? ` at ${where}` : ''}${f.package ? ` in ${f.package.split('/').at(-1)}` : ''}`,
        )
        if (f.inApp && f.context?.line) lines.push(`    > ${f.context.line.trim()}`)
      }
    }
    if (!event.exceptions.length) lines.push('', event.message)
    if (event.breadcrumbs.length) {
      lines.push('', '## Breadcrumbs, oldest first')
      for (const b of event.breadcrumbs.slice(-15))
        lines.push(
          `- ${b.timestamp ? when(b.timestamp) : ''} ${b.category ?? b.type ?? ''}: ${b.message ?? JSON.stringify(b.data ?? '')}`,
        )
    }
    const contexts = Object.entries(event.contexts)
    if (contexts.length) {
      lines.push('', '## Contexts')
      for (const [name, value] of contexts) lines.push(`- ${name}: ${JSON.stringify(value)}`)
    }
    if (event.traceId) lines.push('', `trace: ${event.traceId} (search_logs with query "trace:${event.traceId}")`)
  }
  const notes = d.activity.filter((a) => a.kind === 'note')
  if (notes.length) {
    lines.push('', '## Notes')
    for (const n of notes) lines.push(`- ${when(n.at)} ${n.by}: ${(JSON.parse(n.data!) as { text: string }).text}`)
  }
  return lines.join('\n')
}

const TOOLS: Tool[] = [
  {
    name: 'search_issues',
    description:
      'Search issues (grouped crashes and errors) with Sentry\'s query syntax, e.g. `is:unresolved level:fatal release:1.0 device:iPad* "audio engine"`. Returns id, title, status, counts and when last seen.',
    inputSchema: schema({
      query: string('Sentry search query; defaults to is:unresolved'),
      project: string('project slug, to search only one'),
      sort: { type: 'string', enum: Object.keys(issues.SORTS), description: 'defaults to lastSeen' },
    }),
    run: async (a, { db, viewer }) => {
      const sort = (argString(a.sort) as issues.Sort | undefined) ?? 'lastSeen'
      const list = await issues.listIssues(
        db,
        {
          query: argString(a.query) ?? 'is:unresolved',
          projectId: await projectId(db, a.project),
          sort: Object.hasOwn(issues.SORTS, sort) ? sort : 'lastSeen',
          page: 0,
          // `assigned:me`, `is:bookmarked` and `is:unread` are the token's person's
          viewer,
        },
        Date.now(),
      )
      if (!list.issues.length) return 'No issues match.'
      return list.issues
        .map(
          (i) =>
            `#${i.id} [${i.project}] ${i.title} · ${i.status}${i.substatus ? `/${i.substatus}` : ''} · ${i.level} · ${i.count} events · last ${when(i.last_seen)}${i.last_release ? ` in ${i.last_release}` : ''}`,
        )
        .join('\n')
    },
  },
  {
    name: 'get_issue',
    description:
      'Read one issue: counts, top tags, the latest (or a given) event with its stack trace, breadcrumbs and contexts, and notes.',
    inputSchema: schema({ id: integer('issue id'), event: string('an event id of the issue, instead of the latest') }, [
      'id',
    ]),
    run: async (a, { db, origin }) => {
      const d = await issues.getIssue(db, need(argInt(a.id), 'id'), argString(a.event, 64), Date.now())
      if (!d) return 'No such issue.'
      const repo = await db
        .prepare('SELECT repo_url FROM projects WHERE id = ?')
        .bind(d.issue.project_id)
        .first<{ repo_url: string | null }>()
      const event = d.eventJson ? (JSON.parse(d.eventJson) as NormalizedEvent) : null
      const suspects = await suspectCommits(db, d.issue, event, repo?.repo_url ?? null)
      const text = issueText(d, origin)
      if (!suspects.length) return text
      return `${text}\n\n## Suspect commits, in ${d.issue.first_release}, that changed a file in the stack\n${suspects
        .map(
          (c) =>
            `- ${c.sha.slice(0, 12)} ${c.message.split('\n')[0]}${c.author ? ` · ${c.author}` : ''} · ${c.files.join(', ')}`,
        )
        .join('\n')}`
    },
  },
  {
    name: 'search_logs',
    description:
      'Search logs, newest first: `level:error song:42 "export failed"`, `trace:<id>`, attributes as key:value.',
    inputSchema: schema({
      query: string('Sentry search query'),
      project: string('project slug'),
      range: { type: 'string', enum: Object.keys(RANGES), description: 'how far back; defaults to 24h' },
    }),
    run: async (a, { db }) => {
      const range = (argString(a.range) as Range | undefined) ?? '24h'
      const { logs } = await listLogs(
        db,
        {
          query: argString(a.query) ?? '',
          projectId: await projectId(db, a.project),
          window: { range: Object.hasOwn(RANGES, range) ? range : '24h' },
        },
        Date.now(),
      )
      if (!logs.length) return 'No logs match.'
      return logs
        .map((l) => {
          const own = Object.entries(JSON.parse(l.attributes) as Record<string, unknown>).filter(
            ([k]) => !k.startsWith('sentry.'),
          )
          return `${when(l.timestamp)} ${l.level.toUpperCase()} [${l.project}] ${l.body}${own.length ? ` {${own.map(([k, v]) => `${k}=${v}`).join(' ')}}` : ''}${l.trace_id ? ` trace=${l.trace_id}` : ''}`
        })
        .join('\n')
    },
  },
  {
    name: 'list_projects',
    description:
      'The projects: slug (what every project argument takes), name, unresolved issues, events in the last 24 hours and the newest release with its share of sessions.',
    inputSchema: schema({}),
    run: async (_, { db }) => {
      const { projects } = await overview(db, Date.now())
      if (!projects.length) return 'No projects yet.'
      return projects
        .map(
          (p) =>
            `${p.slug} · ${p.name} · ${p.unresolved} unresolved · ${p.today} events in 24h${p.newest ? ` · newest release ${p.newest.release} (${pct(p.newest.adoption)} of sessions)` : ''}`,
        )
        .join('\n')
    },
  },
  {
    name: 'list_issue_events',
    description:
      'An issue’s events, newest first, 50 a page: id, time, level, release, environment and any tags asked for. Narrow with a search such as `release:1.2 os:Android*`; pass an id to get_issue as event to read that one.',
    inputSchema: schema(
      {
        id: integer('issue id'),
        query: string('Sentry search over the events, e.g. `device:iPad* environment:production`'),
        tags: { type: 'array', items: { type: 'string' }, description: 'tag columns to add, e.g. ["os", "device"]' },
        before: integer('the `older` cursor a previous page gave, for older events'),
      },
      ['id'],
    ),
    run: async (a, { db }) => {
      const tags = (Array.isArray(a.tags) ? a.tags : []).flatMap((t) => argString(t, 64) ?? []).slice(0, 3)
      const page = await exploreEvents(
        db,
        {
          query: argString(a.query) ?? '',
          range: 'all',
          issueId: need(argInt(a.id), 'id'),
          columns: ['level', 'release', 'environment', ...tags],
          before: argInt(a.before),
        },
        Date.now(),
      )
      if (!page.rows.length) return 'No events match.'
      return [
        ...page.rows.map(
          (r) =>
            `${r.id} · ${when(r.received)} · ${page.columns.map((c, i) => `${c}=${r.values[i] || '-'}`).join(' ')}`,
        ),
        ...(page.older ? [`older: ${page.older}`] : []),
      ].join('\n')
    },
  },
  {
    name: 'search_events',
    description:
      'Count events across issues (Explore): a search, a time range, and optionally grouped by `level`, `release`, `environment`, `project` or any tag such as `os` or `device`. Answers the total per group, biggest first, e.g. "is it only on iPad?" or "which release brought it?".',
    inputSchema: schema({
      query: string('Sentry search, e.g. `is:unresolved level:fatal` or `issue:123`'),
      project: string('project slug'),
      group_by: string('a column or tag to group by'),
      count: {
        type: 'string',
        enum: ['count', 'count_unique(user)'],
        description: 'events or users; defaults to count',
      },
      range: { type: 'string', enum: Object.keys(RANGES), description: 'how far back; defaults to 24h' },
    }),
    run: async (a, { db }) => {
      const range = oneOf(a.range, Object.keys(RANGES) as Range[], '24h')
      const groupBy = argString(a.group_by, 64)
      const input = {
        query: argString(a.query) ?? '',
        range,
        projectId: await projectId(db, a.project),
        aggregate: oneOf(a.count, ['count', 'count_unique(user)'] as const, 'count'),
      }
      const now = Date.now()
      const what = input.aggregate === 'count' ? 'events' : 'users'
      if (!groupBy) {
        const w = whereOf(input, now)
        const row = await db
          .prepare(
            `SELECT ${input.aggregate === 'count' ? 'COUNT(*)' : 'COUNT(DISTINCT e.user_hash)'} AS n FROM events e WHERE ${w.sql}`,
          )
          .bind(...w.params)
          .first<{ n: number }>()
        return `${row?.n ?? 0} ${what} in the last ${range}.`
      }
      // The 10 biggest values, each counted over the whole range
      const { groups } = await exploreChart(db, { ...input, groupBy }, now)
      if (!groups.length) return `None in the last ${range}.`
      return [
        `${what} in the last ${range}, by ${groupBy}, the 10 biggest:`,
        ...groups.map((g) => `- ${g.value || '(none)'}: ${g.v}`),
      ].join('\n')
    },
  },
  {
    name: 'get_trace',
    description:
      'Everything kept of one trace: its transactions with their spans in order, the errors in it with their issues, and its logs.',
    inputSchema: schema({ trace: string('the 32-character trace id') }, ['trace']),
    run: async (a, { db }) => {
      const id = need(argString(a.trace, 64), 'trace').toLowerCase()
      if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('A trace id is 32 hexadecimal characters.')
      const t = await traceOf(db, id)
      if (!t.events.length && !t.logs.length && !t.transactions.length) return 'Nothing kept for that trace.'
      const lines = [`# Trace ${id}`]
      for (const x of t.transactions) {
        lines.push(
          '',
          `## ${x.name} [${x.project}] · ${ms(x.duration)} · ${when(x.timestamp)} · ${x.release}${x.status ? ` · ${x.status}` : ''}`,
        )
        for (const sp of x.spans.slice(0, 60))
          lines.push(
            `${'  '.repeat(sp.depth)}- +${ms(sp.start)} ${ms(sp.duration)} ${sp.op} ${sp.description}${sp.status && sp.status !== 'ok' ? ` (${sp.status})` : ''}`,
          )
      }
      if (t.events.length) {
        lines.push('', '## Errors')
        for (const e of t.events)
          lines.push(`- ${when(e.received)} #${e.issue_id} [${e.project}] ${e.title} · ${e.level} · event ${e.id}`)
      }
      if (t.logs.length) {
        lines.push('', '## Logs')
        for (const l of t.logs.slice(0, 100))
          lines.push(`- ${when(l.timestamp)} ${l.level.toUpperCase()} [${l.project}] ${l.body}`)
      }
      return lines.join('\n')
    },
  },
  {
    name: 'list_releases',
    description:
      'A project’s releases, newest first: events, issues, sessions, crash-free sessions and users, and adoption (share of the last 24 hours’ sessions).',
    inputSchema: schema({ project: string('project slug') }, ['project']),
    run: async (a, { db }) => {
      const project = await needProject(db, a.project)
      const [rows, health] = await Promise.all([
        listReleases(db, project.id),
        releaseHealth(db, project.id, Date.now()),
      ])
      if (!rows.length) return 'No releases yet.'
      return rows
        .slice(0, 30)
        .map((r) => {
          const h = health.get(r.release)
          return `${r.release} · first ${when(r.first)} · ${plural(r.events, 'event')} in ${plural(r.issues, 'issue')}${h ? ` · ${h.sessions} sessions · crash-free ${pct(h.crashFree)} sessions, ${pct(h.crashFreeUsers)} users · adoption ${pct(h.adoption)}` : ''}`
        })
        .join('\n')
    },
  },
  {
    name: 'get_release',
    description:
      'One release: its health, deploys, commits, and its issues against the release before: new in it, regressed, still happening, and gone.',
    inputSchema: schema({ project: string('project slug'), release: string('the release, as sent') }, [
      'project',
      'release',
    ]),
    run: async (a, { db }) => {
      const project = await needProject(db, a.project)
      const release = need(argString(a.release, 250), 'release')
      const diff = await releaseDiff(db, project.id, release)
      if (!diff) return `No release ${release} in ${project.slug}.`
      const [health, deploys, commits] = await Promise.all([
        releaseHealth(db, project.id, Date.now()).then((h) => h.get(release)),
        deploysOf(db, project.id, release),
        releaseCommits(db, project, release),
      ])
      const issueLines = (title: string, list: typeof diff.fresh) =>
        list.length
          ? [
              '',
              `## ${title}`,
              ...list.map((i) => `- #${i.id} ${i.title} · ${i.level} · ${i.status} · ${i.count ?? 0} events in it`),
            ]
          : []
      return [
        `# ${project.slug} ${release}`,
        `first seen ${when(diff.release.first)} · last ${when(diff.release.last)} · ${diff.release.events} events${diff.previous ? ` · release before: ${diff.previous}` : ''}`,
        health
          ? `${health.sessions} sessions, ${health.users} users · crash-free ${pct(health.crashFree)} sessions, ${pct(health.crashFreeUsers)} users · adoption ${pct(health.adoption)}`
          : 'no sessions',
        ...(deploys.length
          ? [
              '',
              '## Deploys',
              ...deploys.map((d) => `- ${d.environment} ${when(d.finished)}${d.name ? ` · ${d.name}` : ''}`),
            ]
          : []),
        ...(commits.length
          ? [
              '',
              '## Commits',
              ...commits
                .slice(0, 30)
                .map((c) => `- ${c.sha.slice(0, 12)} ${c.message.split('\n')[0]}${c.author ? ` · ${c.author}` : ''}`),
            ]
          : []),
        ...issueLines('New in this release', diff.fresh),
        ...issueLines('Came back in this release', diff.regressed),
        ...issueLines('Still happening', diff.ongoing),
        ...issueLines('Gone since the release before', diff.gone),
      ].join('\n')
    },
  },
  {
    name: 'list_transactions',
    description:
      'A project’s transactions by p95, slowest first: count, errors, p50, p95, p99 and the change in p95 from the release before to the newest.',
    inputSchema: schema(
      {
        project: string('project slug'),
        days: { type: 'string', enum: [...DAYS], description: 'over 1, 7 or 30 days; defaults to 7' },
      },
      ['project'],
    ),
    run: async (a, { db }) => {
      const project = await needProject(db, a.project)
      const days = Number(oneOf(a.days, DAYS, '7'))
      const t = await transactions(db, project.id, days, Date.now())
      if (!t.transactions.length) return `No transactions in the last ${days} days.`
      return [
        ...(t.latest ? [`p95 change: newest release ${t.latest}${t.previous ? ` against ${t.previous}` : ''}`] : []),
        ...t.transactions
          .slice(0, 40)
          .map(
            (x) =>
              `${x.name} · ${x.count} · ${x.errors} errors · p50 ${ms(x.p50)} · p95 ${ms(x.p95)} · p99 ${ms(x.p99)}${x.change !== null ? ` · p95 ${x.change >= 0 ? '+' : ''}${Math.round(x.change * 100)}%` : ''}`,
          ),
      ].join('\n')
    },
  },
  {
    name: 'get_transaction',
    description:
      'One transaction: p50 and p95 per release, and its slowest examples with their spans and trace ids (get_trace reads a trace).',
    inputSchema: schema(
      {
        project: string('project slug'),
        name: string('the transaction name, as list_transactions gives it'),
        days: { type: 'string', enum: [...DAYS], description: 'over 1, 7 or 30 days; defaults to 7' },
      },
      ['project', 'name'],
    ),
    run: async (a, { db }) => {
      const project = await needProject(db, a.project)
      const name = need(argString(a.name, 200), 'name')
      const days = Number(oneOf(a.days, DAYS, '7'))
      const t = await transaction(db, project.id, name, days, Date.now())
      if (!t.releases.length && !t.examples.length) return `No ${name} in the last ${days} days.`
      const lines = [`# ${name} [${project.slug}], last ${days} days`, '', '## By release']
      for (const r of t.releases) lines.push(`- ${r.release}: ${r.count} · p50 ${ms(r.p50)} · p95 ${ms(r.p95)}`)
      for (const e of t.examples.slice(0, 3)) {
        lines.push(
          '',
          `## ${ms(e.duration)} · ${when(e.timestamp)} · ${e.release}${e.trace_id ? ` · trace ${e.trace_id}` : ''}`,
        )
        for (const sp of e.spans.slice(0, 40))
          lines.push(`${'  '.repeat(sp.depth)}- +${ms(sp.start)} ${ms(sp.duration)} ${sp.op} ${sp.description}`)
      }
      return lines.join('\n')
    },
  },
  {
    name: 'list_monitors',
    description: 'Cron monitors and uptime checks: id, project, kind, status, and since when one is failing.',
    inputSchema: schema({ project: string('project slug') }),
    run: async (a, { db }) => {
      const slug = argString(a.project, 60)
      const list = (await listMonitors(db)).filter((m) => !slug || m.project === slug)
      if (!list.length) return 'No monitors.'
      return list
        .map(
          (m) =>
            `#${m.id} [${m.project}] ${m.name} · ${m.kind === 'uptime' ? 'uptime check' : 'cron monitor'} · ${m.status}${m.incident_since ? ` since ${when(m.incident_since)}` : ''}`,
        )
        .join('\n')
    },
  },
  {
    name: 'get_monitor',
    description:
      'One monitor: uptime over 24 hours, 7 and 30 days, its latest results or check-ins, incidents with why, environments, and errors during the job.',
    inputSchema: schema({ id: integer('monitor id') }, ['id']),
    run: async (a, { db }) => {
      const d = await getMonitor(db, need(argInt(a.id), 'id'), Date.now())
      if (!d) return 'No such monitor.'
      const m = d.monitor
      const lines = [
        `# ${m.name} [${m.project}] · ${m.kind === 'uptime' ? 'uptime check' : 'cron monitor'} · ${m.status}`,
        `up ${pct(d.uptime.day)} over 24h, ${pct(d.uptime.week)} over 7 days, ${pct(d.uptime.month)} over 30`,
      ]
      if (d.results.length) {
        lines.push('', '## Latest results')
        for (const r of d.results.slice(0, 15))
          lines.push(
            `- ${when(r.at)} ${r.ok ? 'ok' : 'failed'}${r.status ? ` ${r.status}` : ''} ${ms(r.ms)}${r.error ? ` · ${r.error}` : ''}`,
          )
      }
      if (d.checkins.length) {
        lines.push('', '## Latest check-ins')
        for (const c of d.checkins.slice(0, 15))
          lines.push(
            `- ${when(c.started)} ${c.status}${c.duration !== null ? ` ${ms(c.duration)}` : ''}${c.environment ? ` · ${c.environment}` : ''}${c.release ? ` · ${c.release}` : ''}`,
          )
      }
      if (d.environments.length) {
        lines.push('', '## Environments')
        for (const e of d.environments)
          lines.push(`- ${e.environment}: ${e.status}, last check-in ${when(e.last_check_in)}`)
      }
      if (d.incidents.length) {
        lines.push('', '## Incidents')
        for (const i of d.incidents.slice(0, 10))
          lines.push(`- ${when(i.opened_at)}${i.closed_at ? ` to ${when(i.closed_at)}` : ', still open'} · ${i.reason}`)
      }
      if (d.errors.length) {
        lines.push('', '## Errors during the job')
        for (const e of d.errors) lines.push(`- ${when(e.received)} #${e.issue_id} ${e.title} · ${e.level}`)
      }
      return lines.join('\n')
    },
  },
  {
    name: 'list_status_pages',
    description:
      'The public status pages: slug, address, the uptime checks each shows (with monitor ids), and its posts still open or ended in 30 days with their ids.',
    inputSchema: schema({}),
    run: async (_, { db }) => {
      const now = Date.now()
      const pages = await status.pagesOf(db, now)
      if (!pages.length) return 'No status pages.'
      const out: string[] = []
      for (const p of pages) {
        const [checks, posts] = await Promise.all([status.checksOf(db, p.id), status.postsOf(db, p.id, now)])
        const shown = checks.filter((c) => c.shown)
        out.push(
          `# ${p.name} · slug ${p.slug} · ${p.domain ?? `/status/${p.slug}`}`,
          `checks: ${shown.length ? shown.map((c) => `#${c.id} ${c.name} (${c.project}, ${c.status})`).join(', ') : 'none'}`,
          ...posts.map(
            (x) =>
              `- post ${x.id}: ${x.title} · ${status.IMPACTS[x.impact]} · ${x.phase} · ${x.updates[0] ? `${status.stateLabel(x.updates[0].state, x.impact)} ${when(x.updates[0].at)}` : ''}`,
          ),
          '',
        )
      }
      return out.join('\n').trim()
    },
  },
  {
    name: 'resolve_issue',
    changes: true,
    description:
      'Resolve one issue or several. in_next_release: only an event from a release other than its latest reopens it. in_release: fixed in that release, so only its events or a newer release’s reopen it.',
    inputSchema: schema({
      ...idOrIds,
      in_next_release: { type: 'boolean' },
      in_release: string('the release with the fix, e.g. 1.0.3'),
    }),
    run: async (a, { db, viewer }) => {
      const ids = issueIds(a)
      const release = argString(a.in_release, 200)?.trim() || undefined
      await issues.changeIssues(
        db,
        ids,
        { action: 'resolve', inRelease: !release && a.in_next_release === true, release },
        viewer,
        Date.now(),
      )
      return `Resolved ${ids.length === 1 ? 'it' : `${ids.length} issues`}${release ? ` in ${release}` : ''}.`
    },
  },
  {
    name: 'ignore_issue',
    changes: true,
    description:
      'Ignore one issue or several: for good, until it escalates, for a number of further events, or for some hours.',
    inputSchema: schema({
      ...idOrIds,
      until_escalating: { type: 'boolean', description: 'until it escalates' },
      for_events: integer('ignore until this many more events'),
      for_hours: integer('ignore for this many hours'),
    }),
    run: async (a, { db, viewer }) => {
      const ids = issueIds(a)
      const hours = argInt(a.for_hours)
      await issues.changeIssues(
        db,
        ids,
        {
          action: 'ignore',
          untilEscalating: a.until_escalating === true,
          forEvents: argInt(a.for_events) || undefined,
          until: hours ? Date.now() + hours * 36e5 : undefined,
        },
        viewer,
        Date.now(),
      )
      return `Ignored ${ids.length === 1 ? 'it' : `${ids.length} issues`}.`
    },
  },
  {
    name: 'reopen_issue',
    changes: true,
    description: 'Reopen resolved or ignored issues, one or several.',
    inputSchema: schema(idOrIds),
    run: async (a, { db, viewer }) => {
      const ids = issueIds(a)
      await issues.changeIssues(db, ids, { action: 'reopen' }, viewer, Date.now())
      return `Reopened ${ids.length === 1 ? 'it' : `${ids.length} issues`}.`
    },
  },
  {
    name: 'set_priority',
    changes: true,
    description: 'Set the priority of one issue or several.',
    inputSchema: schema({ ...idOrIds, priority: { type: 'string', enum: [...PRIORITIES] } }, ['priority']),
    run: async (a, { db, viewer }) => {
      const ids = issueIds(a)
      const priority = need(
        PRIORITIES.includes(a.priority as Priority) ? (a.priority as Priority) : undefined,
        'priority',
      )
      await issues.changeIssues(db, ids, { action: 'priority', priority }, viewer, Date.now())
      return `Priority ${priority}.`
    },
  },
  {
    name: 'assign_issue',
    changes: true,
    description: 'Assign an issue to someone by email, to yourself with "me", or to no one with an empty string.',
    inputSchema: schema({ id: integer('issue id'), to: string('an email, "me", or "" for no one') }, ['id', 'to']),
    run: async (a, { db, viewer }) => {
      const to = need(argString(a.to, 200), 'to').trim()
      const assignee = to === 'me' ? viewer : to || null
      if (assignee && !/^[^\s@]+@[^\s@]+$/.test(assignee)) throw new Error('Assign to an email address, or "me".')
      await issues.assignIssue(db, need(argInt(a.id), 'id'), assignee, viewer, Date.now())
      return assignee ? `Assigned to ${assignee}.` : 'Unassigned.'
    },
  },
  {
    name: 'merge_issues',
    changes: true,
    description:
      'Merge duplicate issues of one project into the first id: their events and counts move there, and their future events follow.',
    inputSchema: schema(
      {
        ids: {
          type: 'array',
          items: { type: 'integer' },
          description: 'the issue to keep first, then those to merge into it',
        },
      },
      ['ids'],
    ),
    run: async (a, { db, viewer }) => {
      const ids = issueIds({ ids: a.ids })
      if (ids.length < 2) throw new Error('Name at least two issues.')
      const into = await issues.mergeIssues(db, ids, viewer, Date.now())
      return `Merged into #${into}.`
    },
  },
  {
    name: 'link_issue',
    changes: true,
    description: 'Link an issue to a GitHub or Linear issue or pull request, or unlink it with an empty url.',
    inputSchema: schema({ id: integer('issue id'), url: string('the http or https link, or ""') }, ['id', 'url']),
    run: async (a, { db, viewer }) => {
      const url = need(argString(a.url, 500), 'url').trim() || null
      if (url && !(URL.canParse(url) && /^https?:$/.test(new URL(url).protocol)))
        throw new Error('The url starts with https://.')
      await issues.linkIssue(db, need(argInt(a.id), 'id'), url, viewer, Date.now())
      return url ? 'Linked.' : 'Unlinked.'
    },
  },
  {
    name: 'add_note',
    changes: true,
    description: 'Add a note to an issue, such as what caused it or the commit that fixes it.',
    inputSchema: schema({ id: integer('issue id'), text: string('the note') }, ['id', 'text']),
    run: async (a, { db, viewer }) => {
      const text = need(argString(a.text, 10_000)?.trim() || undefined, 'text')
      await issues.addNote(db, need(argInt(a.id), 'id'), text, viewer, Date.now())
      return 'Noted.'
    },
  },
  {
    name: 'post_status_update',
    changes: true,
    description:
      'PUBLIC: posts on a status page anyone can read. Either open a post (page, kind, title, message; maintenance also starts and ends) or add an update to one (post, message). States: an incident (minor, major) goes investigating, identified, monitoring, resolved; a notice or maintenance update, resolved. Affects names the page’s checks by monitor id (list_status_pages). Write for the app’s users, never internal details.',
    inputSchema: schema(
      {
        page: string('status page slug, to open a post'),
        post: integer('post id, to add an update to it'),
        kind: {
          type: 'string',
          enum: Object.keys(status.IMPACTS),
          description: 'minor: some services affected; major: an outage',
        },
        title: string('the post’s title'),
        state: string('the update’s state; defaults to the first of its kind'),
        message: string('what people read; **bold**, links and - lists work'),
        affects: {
          type: 'array',
          items: { type: 'integer' },
          description: 'monitor ids of the page’s checks it affects',
        },
        starts: string('maintenance start, ISO 8601'),
        ends: string('maintenance end, ISO 8601'),
      },
      ['message'],
    ),
    run: async (a, { db, viewer }) => {
      const message = need(argString(a.message, 5000)?.trim() || undefined, 'message')
      const affects = Array.isArray(a.affects) ? a.affects.flatMap((m) => argInt(m) ?? []).slice(0, 100) : undefined
      const now = Date.now()
      const postId = argInt(a.post)
      if (postId !== undefined) {
        const post = await status.postOf(db, postId)
        if (!post) throw new Error(`No post ${postId}.`)
        const state = oneOf(a.state, status.STATES_FOR[post.impact], status.STATES_FOR[post.impact][0])
        await status.addUpdate(db, post.id, state, message, viewer, now, post.impact === 'notice' ? undefined : affects)
        return `Posted the update, ${status.stateLabel(state, post.impact)}.`
      }
      const slug = need(argString(a.page, 60), 'page or post')
      const page = await status.pageOf(db, slug)
      if (!page) throw new Error(`No status page ${slug}. list_status_pages names them.`)
      const impact = need(
        Object.keys(status.IMPACTS).includes(a.kind as string) ? (a.kind as status.Impact) : undefined,
        'kind',
      )
      const title = need(argString(a.title, 120)?.trim() || undefined, 'title')
      const time = (v: unknown, name: string) => {
        const t = Date.parse(need(argString(v, 40), name))
        if (Number.isNaN(t)) throw new Error(`${name} is an ISO 8601 time, such as 2026-11-02T22:00:00Z.`)
        return t
      }
      const starts = impact === 'maintenance' ? time(a.starts, 'starts') : null
      const ends = impact === 'maintenance' ? time(a.ends, 'ends') : null
      if (starts !== null && ends! <= starts) throw new Error('Maintenance ends after it starts.')
      const state = oneOf(a.state, status.STATES_FOR[impact], status.STATES_FOR[impact][0])
      const id = await status.createPost(
        db,
        page.id,
        { title, impact, state, message, starts, ends, monitors: impact === 'notice' ? [] : (affects ?? []) },
        viewer,
        now,
      )
      return `Posted to ${page.name} as post ${id}.`
    },
  },
]

const reply = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result })
const failure = (id: Rpc['id'], code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
})

async function handle(rpc: Rpc, ctx: Parameters<Tool['run']>[1]) {
  switch (rpc.method) {
    case 'initialize':
      return reply(rpc.id, {
        protocolVersion: typeof rpc.params?.protocolVersion === 'string' ? rpc.params.protocolVersion : VERSION,
        capabilities: { tools: {} },
        // What clients show for the server (title, icon), as Caliu's does; icons came in MCP 2025-11-25
        serverInfo: {
          name: 'crashyard',
          title: 'crashyard',
          version,
          description: 'Crashes, errors, logs, performance and uptime from your apps, with the Sentry SDKs.',
          websiteUrl: ctx.origin,
          // The dashboard's favicon: inlined by Vite as a data URI, else its path on this crashyard
          icons: [{ src: new URL(favicon, ctx.origin).href, mimeType: 'image/svg+xml', sizes: ['any'] }],
        },
        instructions:
          'Crashes, errors, logs, performance and uptime from your apps. Start with list_projects for the slugs. Search issues, read one with its stack and timeline, look at its events, search events by tag or release, follow its trace, check releases, then triage: resolve, ignore, assign, merge, link or note. post_status_update is public.',
      })
    case 'ping':
      return reply(rpc.id, {})
    case 'tools/list':
      return reply(rpc.id, { tools: TOOLS.map(({ run: _, ...t }) => t) })
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === rpc.params?.name)
      if (!tool) return failure(rpc.id, -32602, `No tool ${String(rpc.params?.name)}`)
      // An agent changes issues as far as its token's scope and its person's role go
      const refusal =
        tool.changes &&
        !reaches(ctx.role, 'member') &&
        'This token can only read. Create one that can change things in Settings, Agent tokens.'
      if (refusal) return reply(rpc.id, { content: [{ type: 'text', text: refusal }], isError: true })
      try {
        const text = await tool.run((rpc.params?.arguments ?? {}) as Record<string, unknown>, ctx)
        return reply(rpc.id, { content: [{ type: 'text', text }] })
      } catch (error) {
        return reply(rpc.id, {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        })
      }
    }
    default:
      return failure(rpc.id, -32601, `No method ${rpc.method}`)
  }
}

/** `who`: the email it acts as and the role it has (src/auth/AGENTS.md) */
export async function handleMcp(request: Request, db: D1Database, who: { email: string; role: Role }) {
  if (request.method !== 'POST')
    return new Response('crashyard’s MCP server takes JSON-RPC over POST', { status: 405, headers: { Allow: 'POST' } })
  // Not from a web page: exactly JSON (a page can't send that without a preflight we don't answer; `text/plain;
  // x=application/json` it can), and from no other site, a sibling subdomain's included (Lax cookies reach /mcp from it)
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  const site = request.headers.get('sec-fetch-site')
  if (type !== 'application/json' || (site !== null && site !== 'same-origin' && site !== 'none')) {
    return new Response('Forbidden', { status: 403 })
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json(failure(null, -32700, 'Parse error'), { status: 400 })
  }
  const ctx = { db, viewer: who.email, role: who.role, origin: new URL(request.url).origin }
  const calls = (Array.isArray(body) ? body : [body]) as Rpc[]
  const answers = []
  for (const rpc of calls) {
    if (!rpc || typeof rpc.method !== 'string') answers.push(failure(null, -32600, 'Invalid request'))
    else if (rpc.id === undefined)
      continue // a notification: nothing to answer
    else answers.push(await handle(rpc, ctx))
  }
  if (!answers.length) return new Response(null, { status: 202 })
  return Response.json(Array.isArray(body) ? answers : answers[0])
}
