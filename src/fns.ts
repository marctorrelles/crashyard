// The dashboard's server functions: what pages load and change, behind Access (src/server.ts). Each checks its input
// here and calls src/data/, which holds the SQL.
import { createServerFn } from '@tanstack/react-start'
import { getCookie, getRequest, getRequestHeader } from '@tanstack/react-start/server'
import { env } from 'cloudflare:workers'
import * as charts from './data/charts'
import * as dashboards from './data/dashboards'
import * as issues from './data/issues'
import * as logs from './data/logs'
import * as monitors from './data/monitors'
import * as notifications from './data/notifications'
import * as performance from './data/performance'
import * as projects from './data/projects'
import * as releases from './data/releases'
import * as source from './data/source'
import * as suggestions from './data/suggest'
import * as tokens from './data/tokens'
import * as updates from './data/updates'
import { ISSUE_KEYS, issueFilter, type KeyInfo, LOG_KEYS } from './search/query'

const viewer = () => getRequestHeader('x-crashyard-viewer') ?? 'unknown'
const origin = () => new URL(getRequest().url).origin

// Input checks: what a page sends is untrusted until it's been through these
type Input = Record<string, unknown>
const object = (v: unknown): Input => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected an object')
  return v as Input
}
const int = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new Error('expected a whole number')
  return n
}
const text = (v: unknown, max = 500) => {
  if (typeof v !== 'string' || v.length > max) throw new Error('expected text')
  return v
}
const optional =
  <T>(check: (v: unknown) => T) =>
  (v: unknown) =>
    v === undefined || v === null || v === '' ? undefined : check(v)
const oneOf =
  <T extends string>(values: readonly T[]) =>
  (v: unknown): T => {
    if (!values.includes(v as T)) throw new Error(`expected one of ${values.join(', ')}`)
    return v as T
  }
const ints = (v: unknown, max = 500) => {
  if (!Array.isArray(v) || v.length > max) throw new Error('expected a list')
  return v.map((x) => int(x))
}
const json = (v: unknown, max = 4000) => {
  const s = text(v, max)
  JSON.parse(s)
  return s
}
const nullableJson = (v: unknown) => (v === null ? null : json(v))

export const getOverview = createServerFn().handler(async () => ({
  ...(await projects.overview(env.DB, Date.now())),
  failing: await monitors.failingMonitors(env.DB),
  update: await updates.update(),
}))

// The overview's charts: 30 days of events per project, new and resolved issues per day, crash-free per release;
// one project's with `project`
export const getOverviewCharts = createServerFn()
  .validator((d: unknown) => ({ project: optional((v) => text(v, 60))(object(d).project) }))
  .handler(async ({ data }) => {
    const project = data.project ? await projects.projectBySlug(env.DB, data.project) : undefined
    return projects.overviewCharts(env.DB, data.project ? [project?.id ?? -1] : undefined, Date.now())
  })

// The sidebar: every project, the one picked last (a cookie it sets, only ever matched against the list), whether
// it was folded (shadcn's own cookie) and who's signed in
export const getSidebar = createServerFn().handler(async () => ({
  projects: await projects.allProjects(env.DB),
  lastProject: getCookie('crashyard_project') ?? null,
  viewer: viewer(),
  sidebarOpen: getCookie('sidebar_state') !== 'false',
}))

export const createProject = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    return { name: text(o.name, 80).trim(), platform: oneOf(projects.PLATFORMS)(o.platform) }
  })
  .handler(({ data }) => {
    if (!data.name) throw new Error('a project needs a name')
    return projects.createProject(env.DB, data.name, data.platform, Date.now())
  })

export const getProjectSettings = createServerFn()
  .validator((d: unknown) => ({ slug: text(object(d).slug, 60) }))
  .handler(async ({ data }) => {
    const project = await projects.projectBySlug(env.DB, data.slug)
    if (!project) return null
    const [list, uploads] = await Promise.all([tokens.listTokens(env.DB), tokens.uploadsOf(env.DB, project.id)])
    return { project, dsn: projects.dsnOf(origin(), project), origin: origin(), tokens: list, uploads, now: Date.now() }
  })

export const updateProject = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    return {
      id: int(o.id),
      name: text(o.name, 80).trim(),
      platform: oneOf(projects.PLATFORMS)(o.platform),
      daily_event_quota: int(o.daily_event_quota, 0, 10_000_000),
      event_retention_days: int(o.event_retention_days, 1, 3650),
      daily_log_quota: int(o.daily_log_quota, 0, 10_000_000),
      log_retention_days: int(o.log_retention_days, 1, 3650),
      repo_url: source.repoUrl(text(o.repo_url ?? '', 300)),
    }
  })
  .handler(({ data: { id, ...change } }) => projects.updateProject(env.DB, id, change))

export const rotateKey = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => projects.rotateKey(env.DB, data.id).then(() => undefined))

export const deleteProject = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => projects.deleteProject(env.DB, data.id).then(() => undefined))

export const getIssues = createServerFn()
  .validator((d: unknown) => {
    const o = object(d)
    return {
      query: text(o.query ?? '', 1000),
      project: optional((v) => text(v, 60))(o.project),
      sort: oneOf(Object.keys(issues.SORTS) as issues.Sort[])(o.sort ?? 'lastSeen'),
      page: int(o.page ?? 0, 0, 1000),
    }
  })
  .handler(async ({ data }) => {
    const project = data.project ? await projects.projectBySlug(env.DB, data.project) : undefined
    const list = await issues.listIssues(
      env.DB,
      { ...data, projectId: project?.id ?? (data.project ? -1 : undefined) },
      Date.now(),
    )
    return { ...list, now: Date.now() }
  })

// The chart over the issues list: events per day and level of the issues the search matches, over the last 14, 30
// or 90 days, and the total per day of the same length of time just before (aligned to the days shown)
export const getIssueChart = createServerFn()
  .validator((d: unknown) => {
    const o = object(d)
    const days = int(o.days ?? 14)
    if (!charts.CHART_DAYS.includes(days as charts.ChartDays)) throw new Error('expected 14, 30 or 90 days')
    return {
      query: text(o.query ?? '', 1000),
      project: optional((v) => text(v, 60))(o.project),
      days: days as charts.ChartDays,
    }
  })
  .handler(async ({ data }) => {
    const project = data.project ? await projects.projectBySlug(env.DB, data.project) : undefined
    const now = Date.now()
    const days = projects.lastDays(data.days, now)
    const before = projects.lastDays(data.days, now - data.days * 864e5)
    const rows = await charts.issueEventsByDay(
      env.DB,
      issueFilter(data.query, now),
      project?.id ?? (data.project ? -1 : undefined),
      [...before, ...days],
    )
    return {
      days,
      series: charts.fill(rows, days),
      previous: charts.fill(rows, before).reduce(
        (sum, s) => sum.map((n, i) => n + s.counts[i]),
        before.map(() => 0),
      ),
    }
  })

export const getIssue = createServerFn()
  .validator((d: unknown) => {
    const o = object(d)
    return { id: int(o.id), event: optional((v) => text(v, 64))(o.event) }
  })
  .handler(async ({ data }) => {
    const now = Date.now()
    const issue = await issues.getIssue(env.DB, data.id, data.event, now)
    if (!issue) return null
    const project = (await projects.projectBySlug(env.DB, issue.issue.project))!
    const links = issue.eventJson ? await source.frameLinks(env.DB, project, JSON.parse(issue.eventJson)) : {}
    return { ...issue, links, now, viewer: viewer() }
  })

export const changeIssues = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    const action = oneOf(['resolve', 'ignore', 'reopen', 'delete'] as const)(o.action)
    const change: issues.IssueChange =
      action === 'resolve'
        ? { action, inRelease: o.inRelease === true }
        : action === 'ignore'
          ? { action, forEvents: optional((v) => int(v, 1))(o.forEvents), until: optional((v) => int(v))(o.until) }
          : { action }
    return { ids: ints(o.ids), change }
  })
  .handler(({ data }) => issues.changeIssues(env.DB, data.ids, data.change, viewer(), Date.now()))

export const mergeIssues = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ ids: ints(object(d).ids) }))
  .handler(({ data }) => issues.mergeIssues(env.DB, data.ids, viewer(), Date.now()))

export const addNote = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    return { id: int(o.id), text: text(o.text, 10_000).trim() }
  })
  .handler(async ({ data }) => {
    if (data.text) await issues.addNote(env.DB, data.id, data.text, viewer(), Date.now())
  })

export const deleteNote = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    return { id: int(o.id), note: int(o.note) }
  })
  .handler(({ data }) => issues.deleteNote(env.DB, data.id, data.note, viewer()).then(() => undefined))

// The project asked for, or every project when there's none (a page's `?project=`); null when it doesn't exist
const projectsFor = async (slug?: string) => {
  if (!slug) return projects.allProjects(env.DB)
  const project = await projects.projectBySlug(env.DB, slug)
  return project ? [project] : null
}

// ponytail: every project's releases are a query or two per project; one query over all if there are dozens
export const getReleases = createServerFn()
  .validator((d: unknown) => {
    const slug = object(d).slug
    return { slug: slug === undefined ? undefined : text(slug, 60) }
  })
  .handler(async ({ data }) => {
    const list = await projectsFor(data.slug)
    if (!list) return null
    const sections = await Promise.all(
      list.map(async (project) => {
        const [rows, sessions] = await Promise.all([
          releases.listReleases(env.DB, project.id),
          performance.sessionsByRelease(env.DB, project.id),
        ])
        return {
          project,
          releases: rows.map((r) => ({ ...r, crashFree: performance.crashFree(sessions.get(r.release)) })),
        }
      }),
    )
    return { sections, now: Date.now() }
  })

export const getRelease = createServerFn()
  .validator((d: unknown) => {
    const o = object(d)
    return { slug: text(o.slug, 60), release: text(o.release, 250) }
  })
  .handler(async ({ data }) => {
    const project = await projects.projectBySlug(env.DB, data.slug)
    const diff = project && (await releases.releaseDiff(env.DB, project.id, data.release))
    if (!project || !diff) return null
    const [sessions, commits] = await Promise.all([
      performance.sessionsByRelease(env.DB, project.id).then((s) => s.get(data.release)),
      source.releaseCommits(env.DB, project, data.release),
    ])
    return { project, ...diff, sessions, crashFree: performance.crashFree(sessions), commits, now: Date.now() }
  })

const DAYS = [1, 7, 30] as const

export const getPerformance = createServerFn()
  .validator((d: unknown) => {
    const o = object(d)
    return {
      slug: o.slug === undefined ? undefined : text(o.slug, 60),
      days: oneOf(DAYS.map(String))(String(o.days ?? 7)),
    }
  })
  .handler(async ({ data }) => {
    const list = await projectsFor(data.slug)
    if (!list) return null
    const now = Date.now()
    return Promise.all(
      list.map(async (project) => ({
        project,
        ...(await performance.transactions(env.DB, project.id, Number(data.days), now)),
      })),
    )
  })

export const getTransaction = createServerFn()
  .validator((d: unknown) => {
    const o = object(d)
    return { slug: text(o.slug, 60), name: text(o.name, 200), days: oneOf(DAYS.map(String))(String(o.days ?? 7)) }
  })
  .handler(async ({ data }) => {
    const project = await projects.projectBySlug(env.DB, data.slug)
    if (!project) return null
    const now = Date.now()
    return { project, now, ...(await performance.transaction(env.DB, project.id, data.name, Number(data.days), now)) }
  })

export const getNotifications = createServerFn().handler(async () => ({
  ...(await notifications.settings(env.DB)),
  projects: await projects.allProjects(env.DB),
  emailReady: !!env.EMAIL_FROM,
}))

const minuteOfDay = optional((v) => int(v, 0, 1439))
export const saveChannel = createServerFn({ method: 'POST' })
  .validator((d: unknown): notifications.ChannelInput => {
    const o = object(d)
    return {
      id: optional((v) => int(v))(o.id),
      kind: oneOf(['ntfy', 'bark', 'email', 'webhook'] as const)(o.kind),
      name: text(o.name, 80).trim() || 'Untitled',
      config: json(o.config),
      quiet_from: minuteOfDay(o.quiet_from) ?? null,
      quiet_to: minuteOfDay(o.quiet_to) ?? null,
    }
  })
  .handler(({ data }) => notifications.saveChannel(env.DB, data, Date.now()))

export const deleteChannel = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => notifications.deleteChannel(env.DB, data.id).then(() => undefined))

export const saveRoute = createServerFn({ method: 'POST' })
  .validator((d: unknown): notifications.RouteInput => {
    const o = object(d)
    return {
      id: optional((v) => int(v))(o.id),
      project_id: optional((v) => int(v))(o.project_id) ?? null,
      kinds: json(o.kinds),
      levels: nullableJson(o.levels ?? null),
      environments: nullableJson(o.environments ?? null),
      thresholds: json(o.thresholds),
      channel_ids: json(o.channel_ids),
    }
  })
  .handler(({ data }) => notifications.saveRoute(env.DB, data, Date.now()))

export const deleteRoute = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => notifications.deleteRoute(env.DB, data.id).then(() => undefined))

export const testRoute = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => notifications.testRoute(env, data.id, origin()))

const cursor = (v: unknown) => {
  const o = object(v)
  return { timestamp: int(o.timestamp), id: int(o.id) }
}
// A logs page's window: `from` and `to` (ms, from < to, 90 days at most) when either is given, else the range
const logWindow = (o: Input): logs.Window => {
  if (o.from === undefined && o.to === undefined)
    return { range: oneOf(Object.keys(logs.RANGES) as logs.Range[])(o.range ?? '24h') }
  const from = int(o.from)
  const to = int(o.to)
  if (from >= to || to - from > logs.MAX_SPAN) throw new Error('expected from before to, 90 days apart at most')
  return { from, to }
}

export const getLogs = createServerFn()
  .validator((d: unknown) => {
    const o = object(d)
    return {
      query: text(o.query ?? '', 1000),
      project: optional((v) => text(v, 60))(o.project),
      window: logWindow(o),
      before: optional(cursor)(o.before),
      after: optional(cursor)(o.after),
    }
  })
  .handler(async ({ data }) => {
    const project = data.project ? await projects.projectBySlug(env.DB, data.project) : undefined
    const now = Date.now()
    const result = await logs.listLogs(
      env.DB,
      { ...data, projectId: project?.id ?? (data.project ? -1 : undefined) },
      now,
    )
    return { ...result, now }
  })

// The logs chart: per bucket and level over the window, and the span before it
export const getLogChart = createServerFn()
  .validator((d: unknown) => {
    const o = object(d)
    return {
      query: text(o.query ?? '', 1000),
      project: optional((v) => text(v, 60))(o.project),
      window: logWindow(o),
    }
  })
  .handler(async ({ data }) => {
    const project = data.project ? await projects.projectBySlug(env.DB, data.project) : undefined
    return logs.logsByBucket(env.DB, { ...data, projectId: project?.id ?? (data.project ? -1 : undefined) }, Date.now())
  })

// The logs chart and table by a field: a column (level, release, environment, project) or an attribute's key, which
// is only ever bound
export const getLogGroups = createServerFn()
  .validator((d: unknown) => {
    const o = object(d)
    const groupBy = text(o.groupBy, 60)
    if (!/^[\w.-]+$/.test(groupBy)) throw new Error('expected a field to group by')
    return {
      query: text(o.query ?? '', 1000),
      project: optional((v) => text(v, 60))(o.project),
      window: logWindow(o),
      groupBy,
    }
  })
  .handler(async ({ data }) => {
    const project = data.project ? await projects.projectBySlug(env.DB, data.project) : undefined
    return logs.logGroups(env.DB, { ...data, projectId: project?.id ?? (data.project ? -1 : undefined) }, Date.now())
  })

// The search bar's suggestions: without a key, every key (the built-ins, then the tags or attributes stored, by how
// often they're seen); with one, its values starting with `prefix`. Logs count over the range (24 hours by default).
export const getSuggestions = createServerFn()
  .validator((d: unknown) => {
    const o = object(d)
    return {
      scope: oneOf(['issues', 'logs'] as const)(o.scope),
      project: optional((v) => text(v, 60))(o.project),
      key: optional((v) => text(v, 60))(o.key),
      prefix: text(o.prefix ?? '', 200),
      range: oneOf(Object.keys(logs.RANGES) as logs.Range[])(o.range ?? '24h'),
    }
  })
  .handler(async ({ data }): Promise<{ keys: KeyInfo[] } | { values: { value: string; count: number }[] }> => {
    const project = data.project ? await projects.projectBySlug(env.DB, data.project) : undefined
    const projectId = project?.id ?? (data.project ? -1 : undefined)
    const since = Date.now() - logs.RANGES[data.range]
    if (data.key !== undefined)
      return {
        values:
          data.scope === 'issues'
            ? await suggestions.issueValues(env.DB, data.key, data.prefix, projectId)
            : await suggestions.logValues(env.DB, data.key, data.prefix, projectId, since),
      }
    const builtIn = data.scope === 'issues' ? ISSUE_KEYS : LOG_KEYS
    const names = new Set(builtIn.map((k) => k.key))
    const stored =
      data.scope === 'issues'
        ? await suggestions.issueKeys(env.DB, projectId)
        : await suggestions.logKeys(env.DB, projectId, since)
    const what = data.scope === 'issues' ? ['Tag', 'issue'] : ['Attribute', 'log']
    return {
      keys: [
        ...builtIn,
        ...stored
          .filter((k) => !names.has(k.key))
          .map((k): KeyInfo => ({
            key: k.key,
            description: `${what[0]}, ${k.count} ${what[1]}${k.count === 1 ? '' : 's'}`,
            kind: 'tag',
          })),
      ],
    }
  })

export const getDashboards = createServerFn().handler(async () => ({
  dashboards: await dashboards.listDashboards(env.DB),
  now: Date.now(),
}))

// The project a page narrows to: its id, -1 when it doesn't exist (so nothing matches), none for every project
const projectIdOf = async (slug?: string) =>
  slug ? ((await projects.projectBySlug(env.DB, slug))?.id ?? -1) : undefined

// A dashboard and what each of its widgets shows over the window (a range, or `from` and `to`), narrowed to `project`
export const getDashboard = createServerFn()
  .validator((d: unknown) => {
    const o = object(d)
    return { id: int(o.id), project: optional((v) => text(v, 60))(o.project), window: logWindow(o) }
  })
  .handler(async ({ data }) => {
    const dashboard = await dashboards.getDashboard(env.DB, data.id)
    if (!dashboard) return null
    const projectId = await projectIdOf(data.project)
    const now = Date.now()
    // 20 widgets at most (`parseWidgets`), so as many reads at once at most
    const shown = await Promise.all(
      dashboard.widgets.map((w) => dashboards.widgetData(env.DB, w, projectId, data.window, now)),
    )
    return { dashboard, data: Object.fromEntries(dashboard.widgets.map((w, i) => [w.id, shown[i]])), now }
  })

// One widget's data before it's saved: the add-widget dialog's preview
export const previewWidget = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    return {
      widget: dashboards.parseWidgets([o.widget])[0],
      project: optional((v) => text(v, 60))(o.project),
      window: logWindow(o),
    }
  })
  .handler(async ({ data }) =>
    dashboards.widgetData(env.DB, data.widget, await projectIdOf(data.project), data.window, Date.now()),
  )

// A whole dashboard written at once (a new one without `id`), every widget checked; who saved it is recorded
export const saveDashboard = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    const name = text(o.name, 80).trim()
    if (!name) throw new Error('a dashboard needs a name')
    return { id: optional((v) => int(v))(o.id), name, widgets: dashboards.parseWidgets(o.widgets) }
  })
  .handler(({ data }) => dashboards.saveDashboard(env.DB, data, viewer(), Date.now()))

export const deleteDashboard = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => dashboards.deleteDashboard(env.DB, data.id).then(() => undefined))

export const createToken = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ name: text(object(d).name, 80).trim() || 'sentry-cli' }))
  .handler(({ data }) => tokens.createToken(env.DB, data.name, viewer(), Date.now()))

export const revokeToken = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => tokens.revokeToken(env.DB, data.id).then(() => undefined))

export const getMonitors = createServerFn().handler(async () => ({
  monitors: await monitors.listMonitors(env.DB),
  projects: await projects.allProjects(env.DB),
  now: Date.now(),
}))

export const getMonitor = createServerFn()
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(async ({ data }) => {
    const monitor = await monitors.getMonitor(env.DB, data.id)
    return monitor ? { ...monitor, projects: await projects.allProjects(env.DB), now: Date.now() } : null
  })

const httpUrl = (v: unknown) => {
  const u = new URL(text(v, 2000))
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('an http(s) URL')
  return u.toString()
}
export const saveMonitor = createServerFn({ method: 'POST' })
  .validator((d: unknown): monitors.MonitorInput => {
    const o = object(d)
    const c = object(o.config)
    const base = {
      id: optional((v) => int(v))(o.id),
      project_id: int(o.project_id),
      name: text(o.name, 100).trim() || 'Untitled',
      slug: optional((v) => text(v, 100))(o.slug),
      environment: text(o.environment ?? 'production', 64) || 'production',
      failure_threshold: int(o.failure_threshold ?? 1, 1, 100),
      recovery_threshold: int(o.recovery_threshold ?? 1, 1, 100),
    }
    if (o.kind === 'uptime') {
      return {
        ...base,
        kind: 'uptime',
        config: {
          url: httpUrl(c.url),
          method: oneOf(['GET', 'HEAD', 'POST'] as const)(c.method ?? 'GET'),
          expectedStatus: optional((v) => int(v, 100, 599))(c.expectedStatus),
          mustContain: optional((v) => text(v, 200))(c.mustContain),
          intervalMinutes: int(c.intervalMinutes ?? 5, 1, 60),
          timeoutMs: int(c.timeoutMs ?? 10_000, 1000, 30_000),
        },
      }
    }
    const schedule = object(c.schedule)
    return {
      ...base,
      kind: 'cron',
      config: {
        schedule:
          schedule.type === 'interval'
            ? {
                type: 'interval',
                value: int(schedule.value, 1, 1000),
                unit: oneOf(['minute', 'hour', 'day', 'week', 'month', 'year'] as const)(schedule.unit),
              }
            : { type: 'crontab', value: text(schedule.value, 100) },
        timezone: optional((v) => text(v, 64))(c.timezone),
        checkinMargin: optional((v) => int(v, 1, 1440))(c.checkinMargin),
        maxRuntime: optional((v) => int(v, 1, 1440))(c.maxRuntime),
      },
    }
  })
  .handler(async ({ data }) => {
    if (data.kind === 'cron')
      (await import('./monitors/schedule')).nextRun(data.config.schedule, Date.now(), data.config.timezone)
    return monitors.saveMonitor(env.DB, data, Date.now())
  })

export const pauseMonitor = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    return { id: int(o.id), paused: o.paused === true }
  })
  .handler(({ data }) => monitors.setPaused(env.DB, data.id, data.paused, Date.now()))

export const deleteMonitor = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => monitors.deleteMonitor(env.DB, data.id).then(() => undefined))
