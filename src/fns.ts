// The dashboard's server functions: what pages load and change, behind Access (src/server.ts). Each checks its input
// here and calls src/data/, which holds the SQL.
import { createServerFn } from '@tanstack/react-start'
import { getCookie, getRequest, getRequestHeader, setCookie } from '@tanstack/react-start/server'
import { env } from 'cloudflare:workers'
import * as charts from './data/charts'
import * as dashboards from './data/dashboards'
import * as health from './data/health'
import * as issues from './data/issues'
import * as logs from './data/logs'
import * as monitors from './data/monitors'
import * as notifications from './data/notifications'
import * as performance from './data/performance'
import * as projects from './data/projects'
import * as releases from './data/releases'
import * as searches from './data/searches'
import * as settings from './data/settings'
import * as source from './data/source'
import * as suggestions from './data/suggest'
import * as suspectsData from './data/suspects'
import * as tokens from './data/tokens'
import * as updates from './data/updates'
import * as widgets from './data/widgets'
import { PRIORITIES, type Priority } from './ingest/priority'
import { FILTER_LISTS, FILTER_SWITCHES, type Filters } from './ingest/filters'
import { parseGroupingRules } from './ingest/rules'
import { telegramChats, telegramToken } from './notify/channels'
import { type Metric, METRICS, metricQueryError, WINDOW_HOURS } from './notify/metrics'
import { LEVELS } from './notify/notice'
import { frequencyOf, INTERVALS, tagFilterError } from './notify/rules'
import { mailerOf } from './notify/email'
import { version } from '../package.json'
import { ISSUE_KEYS, issueFilter, type KeyInfo, LOG_KEYS } from './search/query'

const viewer = () => getRequestHeader('x-crashyard-viewer') ?? 'unknown'
const ZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC'])
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
  .validator((d: unknown) => {
    const o = object(d)
    const days = int(o.days ?? 30)
    if (!charts.CHART_DAYS.includes(days as charts.ChartDays)) throw new Error('expected 14, 30 or 90 days')
    return { project: optional((v) => text(v, 60))(o.project), days }
  })
  .handler(async ({ data }) => {
    const project = data.project ? await projects.projectBySlug(env.DB, data.project) : undefined
    return projects.overviewCharts(env.DB, data.project ? [project?.id ?? -1] : undefined, Date.now(), data.days)
  })

/** Where the overview opens, from the viewer's Settings, Home: a project that still exists and a range */
export const getHome = createServerFn().handler(async () => {
  const prefs = await settings.getPreferences(env.DB, viewer())
  const project = prefs.homeProject && (await projects.projectBySlug(env.DB, prefs.homeProject))
  return { project: project ? project.slug : undefined, days: prefs.homeRange ? Number(prefs.homeRange) : undefined }
})

// The sidebar: every project, the one picked last (a cookie it sets, only ever matched against the list), whether
// it was folded (shadcn's own cookie) and who's signed in, with their preferences. Times show in their chosen zone, else
// the browser's (a cookie the root's script keeps, `tz`), else UTC on a first visit; server and browser render the same.
export const getSidebar = createServerFn().handler(async () => {
  const [list, preferences] = await Promise.all([
    projects.allProjects(env.DB),
    settings.getPreferences(env.DB, viewer()),
  ])
  const browserZone = getCookie('tz')
  return {
    projects: list,
    lastProject: getCookie('crashyard_project') ?? null,
    viewer: viewer(),
    sidebarOpen: getCookie('sidebar_state') !== 'false',
    preferences,
    zone: preferences.timeZone ?? (browserZone && ZONES.has(browserZone) ? browserZone : 'UTC'),
  }
})

export const createProject = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    return { name: text(o.name, 80).trim(), platform: oneOf(projects.PLATFORMS)(o.platform) }
  })
  .handler(({ data }) => {
    if (!data.name) throw new Error('Give the project a name.')
    return projects.createProject(env.DB, data.name, data.platform, Date.now())
  })

export const getProjectSettings = createServerFn()
  .validator((d: unknown) => ({ slug: text(object(d).slug, 60) }))
  .handler(async ({ data }) => {
    const project = await projects.projectBySlug(env.DB, data.slug)
    if (!project) return null
    const now = Date.now()
    const [uploads, keys, filtered] = await Promise.all([
      tokens.uploadsOf(env.DB, project.id),
      projects.keysOf(env.DB, project.id, now),
      projects.filteredSince(env.DB, project.id, 30, now),
    ])
    // The DSN to show: the first key that's on
    const key = keys.find((k) => k.enabled) ?? keys[0]
    return {
      project,
      keys: keys.map((k) => ({ ...k, dsn: projects.dsnOf(origin(), project.id, k.public_key) })),
      dsn: key ? projects.dsnOf(origin(), project.id, key.public_key) : '',
      publicKey: key?.public_key ?? '',
      origin: origin(),
      uploads,
      filtered,
      now,
    }
  })

// A project's settings: each page sends only its own fields, each checked as here
const limit = (v: unknown) => int(v, 0, 10_000_000)
const retention = (v: unknown) => int(v, 1, 3650)
const PROJECT_CHECKS: { [K in keyof projects.ProjectChange]-?: (v: unknown) => projects.ProjectChange[K] } = {
  name: (v) => {
    const name = text(v, 80).trim()
    if (!name) throw new Error('Give the project a name.')
    return name
  },
  slug: (v) => {
    const slug = text(v, 40).trim()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug))
      throw new Error('A slug is lowercase letters, numbers and dashes, and starts with a letter or number.')
    return slug
  },
  platform: oneOf(projects.PLATFORMS),
  daily_event_quota: limit,
  event_retention_days: retention,
  daily_log_quota: limit,
  log_retention_days: retention,
  daily_transaction_quota: limit,
  repo_url: (v) => source.repoUrl(text(v ?? '', 300)),
  auto_resolve_days: (v) => (v === null || v === '' ? null : int(v, 1, 3650)),
  // A priority per level, or null for the built-in ones
  priorities: (v) => {
    if (v === null) return null
    const o = object(v)
    return JSON.stringify(Object.fromEntries(LEVELS.map((l) => [l, oneOf(PRIORITIES)(o[l])])))
  },
  // Release health thresholds: crash-free sessions as a fraction, new issues as a count; null for none
  release_crash_free_min: (v) => {
    if (v === null || v === '') return null
    const n = typeof v === 'string' ? Number(v) : v
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)
      throw new Error('Crash-free sessions is a percentage from 0 to 100.')
    return n
  },
  release_new_issues_max: (v) => (v === null || v === '' ? null : int(v, 0, 100_000)),
  // Rules that don't parse are refused with the line and why, so ingest only ever reads good ones
  grouping_rules: (v) => {
    const rules = text(v ?? '', 20_000)
    const parsed = parseGroupingRules(rules)
    if ('error' in parsed) throw new Error(`Line ${parsed.line}: ${parsed.error}`)
    return rules.trim() ? rules : null
  },
  // The switches that are on and the lists, each a glob or a domain a line
  filters: (v) => {
    const o = object(v)
    const out: Filters = {}
    for (const key of FILTER_SWITCHES) if (o[key] === true) out[key] = true
    for (const key of FILTER_LISTS) {
      const list = optional((x) => text(x, 20_000))(o[key])
      const items = (list ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      if (items.length > 100) throw new Error('Keep each list to 100 lines at most.')
      if (items.some((l) => l.length > 200)) throw new Error('Keep each line to 200 characters at most.')
      if (items.length) out[key] = items
    }
    return Object.keys(out).length ? JSON.stringify(out) : null
  },
}
export const updateProject = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    const change: Record<string, unknown> = {}
    for (const [field, check] of Object.entries(PROJECT_CHECKS)) if (field in o) change[field] = check(o[field])
    return { id: int(o.id), change: change as projects.ProjectChange }
  })
  .handler(({ data }) => projects.updateProject(env.DB, data.id, data.change))

export const createKey = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    return { project: int(o.project), label: text(o.label ?? '', 80).trim() || 'Untitled' }
  })
  .handler(({ data }) => projects.createKey(env.DB, data.project, data.label, Date.now()).then(() => undefined))

export const updateKey = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    return {
      project: int(o.project),
      id: int(o.id),
      change: {
        label: text(o.label, 80).trim() || 'Untitled',
        enabled: o.enabled === true,
        daily_limit: optional((v) => int(v, 0, 10_000_000))(o.daily_limit) ?? null,
      },
    }
  })
  .handler(({ data }) => projects.updateKey(env.DB, data.project, data.id, data.change).then(() => undefined))

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
      { ...data, projectId: project?.id ?? (data.project ? -1 : undefined), viewer: viewer() },
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
      issueFilter(data.query, now, viewer()),
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
    const event = issue.eventJson ? JSON.parse(issue.eventJson) : null
    const who = viewer()
    const [links, suspects, similar, bookmarked, assignees] = await Promise.all([
      event ? source.frameLinks(env.DB, project, event) : {},
      suspectsData.suspectCommits(env.DB, issue.issue, event, project.repo_url),
      suspectsData.similarIssues(env.DB, issue.issue, event),
      issues.isBookmarked(env.DB, who, data.id),
      issues.assignees(env.DB, who),
      // Opened by a person: read until its next event. An agent's read doesn't count
      who.startsWith('service:') || who === 'unknown' ? undefined : issues.markViewed(env.DB, who, data.id, now),
    ])
    return {
      ...issue,
      links,
      suspects,
      similar,
      bookmarked,
      assignees,
      repoUrl: project.repo_url,
      origin: origin(),
      now,
      viewer: who,
    }
  })

export const changeIssues = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    const action = oneOf(['resolve', 'ignore', 'reopen', 'delete', 'priority'] as const)(o.action)
    const change: issues.IssueChange =
      action === 'resolve'
        ? {
            action,
            inRelease: o.inRelease === true,
            current: o.current === true,
            release: optional((v) => text(v, 200))(o.release),
          }
        : action === 'ignore'
          ? {
              action,
              forEvents: optional((v) => int(v, 1))(o.forEvents),
              forUsers: optional((v) => int(v, 1))(o.forUsers),
              until: optional((v) => int(v))(o.until),
              untilEscalating: o.untilEscalating === true,
            }
          : action === 'priority'
            ? { action, priority: oneOf<Priority>(PRIORITIES)(o.priority) }
            : action === 'delete'
              ? { action, discard: o.discard === true }
              : { action }
    return { ids: ints(o.ids), change }
  })
  .handler(({ data }) => issues.changeIssues(env.DB, data.ids, data.change, viewer(), Date.now()))

export const mergeIssues = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ ids: ints(object(d).ids) }))
  .handler(({ data }) => issues.mergeIssues(env.DB, data.ids, viewer(), Date.now()))

export const assignIssue = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    const assignee = optional((v) => text(v, 200).trim())(o.assignee) ?? null
    if (assignee !== null && !/^[^\s@]+@[^\s@]+$/.test(assignee)) throw new Error('Assign to an email address.')
    return { id: int(o.id), assignee }
  })
  .handler(({ data }) => issues.assignIssue(env.DB, data.id, data.assignee, viewer(), Date.now()))

export const bookmarkIssue = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    return { id: int(o.id), on: o.on === true }
  })
  .handler(({ data }) => issues.bookmarkIssue(env.DB, viewer(), data.id, data.on).then(() => undefined))

export const linkIssue = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    const url = optional((v) => text(v, 500).trim())(o.url) ?? null
    if (url !== null && !(URL.canParse(url) && /^https?:$/.test(new URL(url).protocol)))
      throw new Error('That isn’t a web address. Paste the issue’s link, starting with https://.')
    return { id: int(o.id), url }
  })
  .handler(({ data }) => issues.linkIssue(env.DB, data.id, data.url, viewer(), Date.now()))

export const getMergedFingerprints = createServerFn()
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => issues.mergedFingerprints(env.DB, data.id))

export const unmergeIssue = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    return { id: int(o.id), fingerprint: text(o.fingerprint, 200) }
  })
  .handler(({ data }) => issues.unmergeIssue(env.DB, data.id, data.fingerprint, viewer(), Date.now()))

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
    const now = Date.now()
    const sections = await Promise.all(
      list.map(async (project) => {
        const [rows, health] = await Promise.all([
          releases.listReleases(env.DB, project.id),
          releases.releaseHealth(env.DB, project.id, now),
        ])
        return {
          project,
          releases: rows.map((r, i) => {
            const h = health.get(r.release)
            const newer = rows.slice(0, i).map((n) => health.get(n.release)?.adoption ?? null)
            return {
              ...r,
              sessions: h?.sessions ?? 0,
              users: h?.users ?? 0,
              adoption: h?.adoption ?? null,
              stage: releases.adoptionStage(h?.adoption ?? null, newer),
              crashFree: h?.crashFree ?? null,
              crashFreeUsers: h?.crashFreeUsers ?? null,
            }
          }),
        }
      }),
    )
    return { sections, now }
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
    const now = Date.now()
    const [all, commits, adoption, deploys] = await Promise.all([
      releases.releaseHealth(env.DB, project.id, now),
      source.releaseCommits(env.DB, project, data.release),
      releases.adoptionByDay(env.DB, project.id, data.release, now),
      releases.deploysOf(env.DB, project.id, data.release),
    ])
    const health = all.get(data.release) ?? null
    return {
      project,
      ...diff,
      health,
      healthy: releases.healthOf(project, { crashFree: health?.crashFree ?? null, newIssues: diff.fresh.length }),
      adoption,
      deploys,
      commits,
      now,
    }
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
        vitals: await performance.vitals(env.DB, project.id, Number(data.days), now),
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
    const [detail, vitals] = await Promise.all([
      performance.transaction(env.DB, project.id, data.name, Number(data.days), now),
      performance.vitals(env.DB, project.id, Number(data.days), now, data.name),
    ])
    return { project, now, ...detail, vitals }
  })

export const getNotifications = createServerFn().handler(async () => ({
  ...(await notifications.settings(env.DB)),
  projects: await projects.allProjects(env.DB),
  emailReady: !!env.EMAIL_FROM,
  now: Date.now(),
}))

const minuteOfDay = optional((v) => int(v, 0, 1439))
export const saveChannel = createServerFn({ method: 'POST' })
  .validator((d: unknown): notifications.ChannelInput => {
    const o = object(d)
    return {
      id: optional((v) => int(v))(o.id),
      kind: oneOf(['telegram', 'email', 'webhook'] as const)(o.kind),
      name: text(o.name, 80).trim() || 'Untitled',
      config: json(o.config),
      quiet_from: minuteOfDay(o.quiet_from) ?? null,
      quiet_to: minuteOfDay(o.quiet_to) ?? null,
    }
  })
  .handler(({ data }) => notifications.saveChannel(env.DB, data, Date.now()))

/** The chats that wrote to a Telegram bot lately, for its channel's chat */
export const findTelegramChats = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const token = telegramToken(text(object(d).token, 500))
    if (!token) throw new Error('That isn’t a bot token. Copy the token from @BotFather, it looks like 123456789:AA…')
    return { token }
  })
  .handler(({ data }) => telegramChats(data.token))

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
      frequency: routeFrequency(o.frequency),
      releases: routeReleases(o.releases),
      query: routeQuery(o.query),
      interval_minutes: Number(oneOf(INTERVALS.map(String))(String(o.interval_minutes ?? 0))),
    }
  })
  .handler(({ data }) => {
    if (data.kinds.includes('"frequency"') && !data.frequency)
      throw new Error('Say how many events or users an issue gets, and in what time, for Frequency reached.')
    return notifications.saveRoute(env.DB, data, Date.now())
  })

// A route's frequency: a count of events or users, and a window
const routeFrequency = (v: unknown) => {
  if (v === null || v === undefined) return null
  const s = json(v, 200)
  if (!frequencyOf(s)) throw new Error('Give a whole number of events or users above 0, and a time.')
  return s
}
// Release globs, one per item
const routeReleases = (v: unknown) => {
  if (v === null || v === undefined) return null
  const list = JSON.parse(json(v, 2000)) as unknown
  if (!Array.isArray(list) || list.some((g) => typeof g !== 'string' || g.length > 200))
    throw new Error('expected a list of releases')
  return list.length ? JSON.stringify(list) : null
}
// Tag filters, checked as they'll be matched
const routeQuery = (v: unknown) => {
  const query = text(v ?? '', 1000).trim()
  const error = query && tagFilterError(query)
  if (error) throw new Error(error)
  return query || null
}

export const saveMetricAlert = createServerFn({ method: 'POST' })
  .validator((d: unknown): notifications.MetricAlertInput => {
    const o = object(d)
    const metric = oneOf(Object.keys(METRICS) as Metric[])(o.metric)
    const query = text(o.query ?? '', 1000).trim()
    const error = metricQueryError(metric, query)
    if (error) throw new Error(error)
    const number = (v: unknown) => {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0)
        throw new Error('Give the values as numbers, 0 or more.')
      return n
    }
    const name = text(o.name, 80).trim()
    if (!name) throw new Error('Give the alert a name. It’s the title of every alert it sends.')
    return {
      id: optional((v) => int(v))(o.id),
      project_id: int(o.project_id),
      name,
      metric,
      query,
      window_hours: Number(oneOf(WINDOW_HOURS.map(String))(String(o.window_hours))),
      direction: oneOf(['above', 'below'] as const)(o.direction),
      warning: optional(number)(o.warning) ?? null,
      critical: number(o.critical),
    }
  })
  .handler(({ data }) => {
    if (
      data.warning !== null &&
      (data.direction === 'above' ? data.warning >= data.critical : data.warning <= data.critical)
    )
      throw new Error(
        `The warning value comes before the critical one, so it’s ${data.direction === 'above' ? 'lower' : 'higher'}.`,
      )
    return notifications.saveMetricAlert(env.DB, data, viewer(), Date.now())
  })

export const deleteMetricAlert = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => notifications.deleteMetricAlert(env.DB, data.id).then(() => undefined))

export const deleteRoute = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => notifications.deleteRoute(env.DB, data.id).then(() => undefined))

export const testRoute = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => notifications.testRoute(env, data.id, origin()))

export const testChannel = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => notifications.testChannel(env, data.id, origin()))

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

// The logs page's maths: a chart for each of `functions` (count, or avg, sum, min, max or a percentile of a numeric
// attribute) by up to 2 fields, and a table of the groups with a column for each of `table`'s
export const getLogMaths = createServerFn()
  .validator((d: unknown) => {
    const o = object(d)
    const list = (v: unknown, max: number) => {
      if (!Array.isArray(v) || v.length > max) throw new Error(`expected ${max} at most`)
      return v.map((x) => text(x, 80))
    }
    const functions = list(o.functions ?? [], widgets.MAX_QUERIES)
    const table = list(o.table ?? [], widgets.MAX_QUERIES)
    for (const f of [...functions, ...table]) {
      const error = widgets.aggregateError('logs', f)
      if (error) throw new Error(error)
    }
    const groupBy = list(o.groupBy ?? [], 2)
    if (!groupBy.every((g) => /^[\w.-]{1,60}$/.test(g))) throw new Error('expected fields to group by')
    return {
      query: text(o.query ?? '', 1000),
      project: optional((v) => text(v, 60))(o.project),
      window: logWindow(o),
      functions: functions as widgets.Aggregate[],
      table: table as widgets.Aggregate[],
      groupBy,
    }
  })
  .handler(async ({ data }) => {
    const projectId = await projectIdOf(data.project)
    const now = Date.now()
    const widget = (display: widgets.Display, queries: widgets.WidgetQuery[]): widgets.Widget => ({
      id: '00000000',
      title: 'Logs',
      dataset: 'logs',
      display,
      queries,
      ...(data.groupBy.length ? { groupBy: data.groupBy } : {}),
      width: 3,
    })
    const read = (w: widgets.Widget) => widgets.widgetData(env.DB, w, projectId, data.window, now)
    const [table, ...charts] = await Promise.all([
      data.table.length && data.groupBy.length
        ? read(
            widget(
              'table',
              data.table.map((aggregate) => ({ query: data.query, aggregate })),
            ),
          )
        : undefined,
      ...data.functions.map((aggregate) => read(widget('line', [{ query: data.query, aggregate }]))),
    ])
    return { charts, table }
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

// The dashboard's filter bar: an environment, a release and a search, each laid over the widgets that know its key
const dashboardFilters = (o: Input): widgets.Filters => ({
  environment: optional((v) => text(v, 200))(o.environment),
  release: optional((v) => text(v, 200))(o.release),
  query: optional((v) => text(v, 1000))(o.filter),
})

// A dashboard and what each of its widgets shows over the window (a range, or `from` and `to`), narrowed to `project`
// and the filter bar, with the bar's choices
export const getDashboard = createServerFn()
  .validator((d: unknown) => {
    const o = object(d)
    return {
      id: int(o.id),
      project: optional((v) => text(v, 60))(o.project),
      window: logWindow(o),
      filters: dashboardFilters(o),
    }
  })
  .handler(async ({ data }) => {
    const dashboard = await dashboards.getDashboard(env.DB, data.id)
    if (!dashboard) return null
    const projectId = await projectIdOf(data.project)
    const now = Date.now()
    // 20 widgets at most (`parseWidgets`), so as many reads at once at most
    const [options, ...shown] = await Promise.all([
      dashboards.filterOptions(env.DB, projectId, now),
      ...dashboard.widgets.map((w) => widgets.widgetData(env.DB, w, projectId, data.window, now, data.filters)),
    ])
    return {
      dashboard,
      data: Object.fromEntries(dashboard.widgets.map((w, i) => [w.id, shown[i]])),
      options,
      now,
    }
  })

// One widget's data before it's saved: the widget builder's preview, and the viewer's other displays
export const previewWidget = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    return {
      widget: widgets.parseWidgets([o.widget])[0],
      project: optional((v) => text(v, 60))(o.project),
      window: logWindow(o),
      filters: dashboardFilters(o),
    }
  })
  .handler(async ({ data }) =>
    widgets.widgetData(env.DB, data.widget, await projectIdOf(data.project), data.window, Date.now(), data.filters),
  )

// A whole dashboard written at once (a new one without `id`), every widget checked; who saved it is recorded
export const saveDashboard = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    const name = text(o.name, 80).trim()
    if (!name) throw new Error('Give the dashboard a name.')
    return { id: optional((v) => int(v))(o.id), name, widgets: widgets.parseWidgets(o.widgets) }
  })
  .handler(({ data }) => dashboards.saveDashboard(env.DB, data, viewer(), Date.now()))

// The widget lists a dashboard had before its last 10 saves
export const getDashboardHistory = createServerFn()
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => dashboards.dashboardHistory(env.DB, data.id))

// A dashboard back to the widgets it had before a save; the ones it has now become a revision in turn
export const restoreDashboard = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    return { id: int(o.id), index: int(o.index, 0, dashboards.MAX_REVISIONS - 1) }
  })
  .handler(async ({ data }) => {
    const d = await dashboards.getDashboard(env.DB, data.id)
    if (!d) throw new Error('This dashboard no longer exists.')
    const list = await dashboards.revisionWidgets(env.DB, data.id, data.index)
    if (list.some((w) => w.invalid))
      throw new Error('That version has widgets that can’t be read, so it can’t be restored.')
    return dashboards.saveDashboard(env.DB, { id: d.id, name: d.name, widgets: list }, viewer(), Date.now())
  })

// One widget added at the end of a dashboard: the logs page's "Add to dashboard"
export const addWidget = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    return { id: int(o.id), widget: widgets.parseWidgets([o.widget])[0] }
  })
  .handler(({ data }) => dashboards.addWidget(env.DB, data.id, data.widget, viewer(), Date.now()))

export const deleteDashboard = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => dashboards.deleteDashboard(env.DB, data.id).then(() => undefined))

// A token for one project (`project`, its id) or every project
export const createToken = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    return { name: text(o.name, 80).trim() || 'sentry-cli', project: optional((v) => int(v))(o.project) ?? null }
  })
  .handler(({ data }) => tokens.createToken(env.DB, data.name, viewer(), Date.now(), data.project))

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
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('The URL must start with http:// or https://.')
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

// Settings: the deployment's (anyone signed in may change them, as every other page) and the viewer's own

export const getProjectPage = createServerFn()
  .validator((d: unknown) => ({ slug: text(object(d).slug, 60) }))
  .handler(async ({ data }) => {
    const project = await projects.projectBySlug(env.DB, data.slug)
    return project ? { debugFiles: await tokens.debugFilesOf(env.DB, project.id), now: Date.now() } : null
  })

export const deleteDebugFile = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    return { project: int(o.project), id: int(o.id) }
  })
  .handler(({ data }) => tokens.deleteDebugFile(env.DB, env.FILES, data.project, data.id))

export const getInstanceSettings = createServerFn().handler(async () => {
  const [defaults, scrubFields, agentsCanChange, update] = await Promise.all([
    settings.projectDefaults(env.DB),
    settings.getSetting<string[]>(env.DB, settings.SCRUB_KEY, []),
    settings.getSetting(env.DB, settings.AGENTS_KEY, false),
    updates.update(),
  ])
  return {
    origin: origin(),
    publicUrl: env.PUBLIC_URL || null,
    access: { team: env.ACCESS_TEAM_DOMAIN || null, audience: !!env.ACCESS_AUD },
    emailFrom: env.EMAIL_FROM || null,
    defaults,
    scrubFields,
    agentsCanChange,
    version,
    update,
  }
})

export const saveProjectDefaults = createServerFn({ method: 'POST' })
  .validator((d: unknown): settings.ProjectDefaults => {
    const o = object(d)
    return {
      daily_event_quota: limit(o.daily_event_quota),
      daily_log_quota: limit(o.daily_log_quota),
      daily_transaction_quota: limit(o.daily_transaction_quota),
      event_retention_days: retention(o.event_retention_days),
      log_retention_days: retention(o.log_retention_days),
    }
  })
  .handler(({ data }) => settings.setSetting(env.DB, 'defaults.project', data, viewer()).then(() => undefined))

export const saveScrubFields = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const list = object(d).fields
    if (!Array.isArray(list) || list.length > 100) throw new Error('expected a list')
    return { fields: [...new Set(list.map((f) => text(f, 80).trim()).filter(Boolean))] }
  })
  .handler(({ data }) => settings.setSetting(env.DB, settings.SCRUB_KEY, data.fields, viewer()).then(() => undefined))

export const saveAgentsCanChange = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ on: object(d).on === true }))
  .handler(({ data }) => settings.setSetting(env.DB, settings.AGENTS_KEY, data.on, viewer()).then(() => undefined))

export const sendTestEmail = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const to = text(object(d).to, 200).trim()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('That isn’t an email address.')
    return { to }
  })
  .handler(async ({ data }) => {
    const mailer = mailerOf(env.EMAIL)
    if (!mailer || !env.EMAIL_FROM) throw new Error('Email isn’t set up. Set EMAIL_FROM, then deploy again.')
    try {
      await mailer.send(
        env.EMAIL_FROM,
        data.to,
        'crashyard test email',
        `This is a test from crashyard at ${origin()}. Email notifications will reach this address.`,
      )
    } catch (error) {
      console.error('test email failed', error)
      throw new Error(`The email wasn’t sent. Check that ${data.to} is a verified destination in Email Routing.`, {
        cause: error,
      })
    }
  })

export const getTokens = createServerFn().handler(async () => ({
  tokens: await tokens.listTokens(env.DB),
  projects: await projects.allProjects(env.DB),
  agentsCanChange: await settings.getSetting(env.DB, settings.AGENTS_KEY, false),
  origin: origin(),
  now: Date.now(),
}))

export const getUsage = createServerFn()
  .validator((d: unknown) => ({ project: optional((v) => text(v, 60))(object(d).project) }))
  .handler(async ({ data }) => health.usage(env.DB, await projectIdOf(data.project), 30, Date.now()))

export const getHealth = createServerFn().handler(async () => {
  const now = Date.now()
  return { ...(await health.health(env, now)), now }
})

const PREFERENCE_CHECKS: { [K in keyof settings.Preferences]-?: (v: unknown) => settings.Preferences[K] | undefined } =
  {
    theme: oneOf(['system', 'light', 'dark'] as const),
    timeZone: optional((v) => {
      const zone = text(v, 64)
      if (!ZONES.has(zone)) throw new Error('expected a time zone')
      return zone
    }),
    clock: oneOf(['24', '12'] as const),
    stackOrder: oneOf(['newest', 'oldest'] as const),
    showOtherFrames: (v) => v === true,
    homeProject: optional((v) => text(v, 60)),
    homeRange: optional(oneOf(['14', '30', '90'] as const)),
  }

/** One preference of the viewer's; the theme goes in a cookie too, for the script that sets it before paint */
export const savePreference = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    const key = oneOf(Object.keys(PREFERENCE_CHECKS) as (keyof settings.Preferences)[])(o.key)
    return { key, value: PREFERENCE_CHECKS[key](o.value) }
  })
  .handler(async ({ data }) => {
    await settings.setPreference(env.DB, viewer(), data.key, data.value)
    if (data.key === 'theme')
      setCookie('theme', String(data.value), { path: '/', maxAge: 31_536_000, sameSite: 'lax', secure: true })
  })

// Saved searches of a page: the viewer's own and everyone's shared ones, the viewer's pinned one first
export const getSavedSearches = createServerFn()
  .validator((d: unknown) => ({ page: oneOf(searches.PAGES)(object(d).page) }))
  .handler(({ data }) => searches.listSavedSearches(env.DB, viewer(), data.page))

export const saveSearch = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    const name = text(o.name, 80).trim()
    if (!name) throw new Error('Give the search a name.')
    return { page: oneOf(searches.PAGES)(o.page), name, query: text(o.query ?? '', 1000), shared: o.shared === true }
  })
  .handler(({ data }) => searches.saveSearch(env.DB, viewer(), data, Date.now()))

export const pinSearch = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = object(d)
    return { id: int(o.id), pinned: o.pinned === true }
  })
  .handler(({ data }) => searches.pinSearch(env.DB, viewer(), data.id, data.pinned))

export const deleteSearch = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => searches.deleteSearch(env.DB, viewer(), data.id))
