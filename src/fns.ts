// The dashboard's server functions: what pages load and change, behind Access (src/server.ts). Each checks its input
// here and calls src/data/, which holds the SQL.
import { createServerFn } from '@tanstack/react-start'
import { getRequest, getRequestHeader } from '@tanstack/react-start/server'
import { env } from 'cloudflare:workers'
import * as issues from './data/issues'
import * as logs from './data/logs'
import * as notifications from './data/notifications'
import * as projects from './data/projects'
import * as releases from './data/releases'

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

export const getOverview = createServerFn().handler(() => projects.overview(env.DB, Date.now()))

export const getProjects = createServerFn().handler(() => projects.allProjects(env.DB))

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
    return project ? { project, dsn: projects.dsnOf(origin(), project), origin: origin() } : null
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

export const getIssue = createServerFn()
  .validator((d: unknown) => {
    const o = object(d)
    return { id: int(o.id), event: optional((v) => text(v, 64))(o.event) }
  })
  .handler(async ({ data }) => {
    const now = Date.now()
    const issue = await issues.getIssue(env.DB, data.id, data.event, now)
    return issue ? { ...issue, now, viewer: viewer() } : null
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

export const getReleases = createServerFn()
  .validator((d: unknown) => ({ slug: text(object(d).slug, 60) }))
  .handler(async ({ data }) => {
    const project = await projects.projectBySlug(env.DB, data.slug)
    return project ? { project, releases: await releases.listReleases(env.DB, project.id), now: Date.now() } : null
  })

export const getRelease = createServerFn()
  .validator((d: unknown) => {
    const o = object(d)
    return { slug: text(o.slug, 60), release: text(o.release, 250) }
  })
  .handler(async ({ data }) => {
    const project = await projects.projectBySlug(env.DB, data.slug)
    const diff = project && (await releases.releaseDiff(env.DB, project.id, data.release))
    return project && diff ? { project, ...diff, now: Date.now() } : null
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
      kind: oneOf(['ntfy', 'email', 'webhook'] as const)(o.kind),
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
export const getLogs = createServerFn()
  .validator((d: unknown) => {
    const o = object(d)
    return {
      query: text(o.query ?? '', 1000),
      project: optional((v) => text(v, 60))(o.project),
      range: oneOf(Object.keys(logs.RANGES) as logs.Range[])(o.range ?? '24h'),
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
