// POST /mcp: an MCP server (Streamable HTTP, answering with JSON), so an agent can search issues and logs, read an
// issue with its stack, and resolve, ignore or note it. Behind Access like the dashboard: agents sign in with an
// Access service token (CF-Access-Client-Id and CF-Access-Client-Secret headers). See docs/mcp.md.
import * as issues from '../data/issues'
import { listLogs, RANGES, type Range } from '../data/logs'
import { projectBySlug } from '../data/projects'
import type { NormalizedEvent } from '../ingest/event'

const VERSION = '2025-06-18'

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> }
type Tool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>, ctx: { db: D1Database; viewer: string; origin: string }) => Promise<string>
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

async function projectId(db: D1Database, slug: unknown) {
  const s = argString(slug, 60)
  if (!s) return undefined
  return (await projectBySlug(db, s))?.id ?? -1
}

const when = (ms: number) => new Date(ms).toISOString().replace('.000', '')

/** An issue as text an agent reads well: the header, counts, top tags, the latest event's stack and breadcrumbs */
function issueText(d: NonNullable<Awaited<ReturnType<typeof issues.getIssue>>>, origin: string) {
  const i = d.issue
  const lines = [
    `# ${i.title}`,
    `${origin}/issues/${i.id} · project ${i.project} · ${i.status}${i.substatus ? ` (${i.substatus})` : ''} · level ${i.level}`,
    `culprit: ${i.culprit || '-'}`,
    `${i.count} events, ${i.user_count} users · first seen ${when(i.first_seen)}${i.first_release ? ` in ${i.first_release}` : ''} · last seen ${when(i.last_seen)}${i.last_release ? ` in ${i.last_release}` : ''}`,
  ]
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
    run: async (a, { db }) => {
      const sort = (argString(a.sort) as issues.Sort | undefined) ?? 'lastSeen'
      const list = await issues.listIssues(
        db,
        {
          query: argString(a.query) ?? 'is:unresolved',
          projectId: await projectId(db, a.project),
          sort: sort in issues.SORTS ? sort : 'lastSeen',
          page: 0,
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
      return d ? issueText(d, origin) : 'No such issue.'
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
          range: range in RANGES ? range : '24h',
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
    name: 'resolve_issue',
    description: 'Resolve an issue. in_next_release: only an event from a release other than its latest reopens it.',
    inputSchema: schema({ id: integer('issue id'), in_next_release: { type: 'boolean' } }, ['id']),
    run: async (a, { db, viewer }) => {
      await issues.changeIssues(
        db,
        [need(argInt(a.id), 'id')],
        { action: 'resolve', inRelease: a.in_next_release === true },
        viewer,
        Date.now(),
      )
      return 'Resolved.'
    },
  },
  {
    name: 'ignore_issue',
    description: 'Ignore an issue: for good, for a number of further events, or for some hours.',
    inputSchema: schema(
      {
        id: integer('issue id'),
        for_events: integer('ignore until this many more events'),
        for_hours: integer('ignore for this many hours'),
      },
      ['id'],
    ),
    run: async (a, { db, viewer }) => {
      const hours = argInt(a.for_hours)
      await issues.changeIssues(
        db,
        [need(argInt(a.id), 'id')],
        {
          action: 'ignore',
          forEvents: argInt(a.for_events) || undefined,
          until: hours ? Date.now() + hours * 36e5 : undefined,
        },
        viewer,
        Date.now(),
      )
      return 'Ignored.'
    },
  },
  {
    name: 'add_note',
    description: 'Add a note to an issue, such as what caused it or the commit that fixes it.',
    inputSchema: schema({ id: integer('issue id'), text: string('the note') }, ['id', 'text']),
    run: async (a, { db, viewer }) => {
      const text = need(argString(a.text, 10_000)?.trim() || undefined, 'text')
      await issues.addNote(db, need(argInt(a.id), 'id'), text, viewer, Date.now())
      return 'Noted.'
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
        serverInfo: { name: 'crashyard', version: '1' },
        instructions:
          'Crashes, errors and logs from your apps. Search issues, read one with its stack, search logs by trace, then resolve or note.',
      })
    case 'ping':
      return reply(rpc.id, {})
    case 'tools/list':
      return reply(rpc.id, { tools: TOOLS.map(({ run: _, ...t }) => t) })
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === rpc.params?.name)
      if (!tool) return failure(rpc.id, -32602, `No tool ${String(rpc.params?.name)}`)
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

export async function handleMcp(request: Request, db: D1Database, viewer: string) {
  if (request.method !== 'POST')
    return new Response('crashyard’s MCP server takes JSON-RPC over POST', { status: 405, headers: { Allow: 'POST' } })
  // Not from a web page: JSON only (a page can't send that cross-site without a preflight we don't answer)
  if (
    !request.headers.get('content-type')?.includes('application/json') ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  ) {
    return new Response('Forbidden', { status: 403 })
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json(failure(null, -32700, 'Parse error'), { status: 400 })
  }
  const ctx = { db, viewer, origin: new URL(request.url).origin }
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
