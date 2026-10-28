// The dashboard's server functions: what pages load and change, for whoever is signed in (src/server.ts). Each checks
// its input here and calls src/data/, which holds the SQL.
import { createMiddleware, createServerFn } from '@tanstack/react-start'
import { getCookie, getRequest, getRequestHeader, setCookie } from '@tanstack/react-start/server'
import { env } from 'cloudflare:workers'
import * as charts from './data/charts'
import * as dashboards from './data/dashboards'
import * as explore from './data/explore'
import * as health from './data/health'
import * as issues from './data/issues'
import * as logs from './data/logs'
import * as monitors from './data/monitors'
import * as notifications from './data/notifications'
import * as people from './data/people'
import { GITHUB_KEY, gitHubApp, startApp } from './auth/github'
import * as performance from './data/performance'
import * as projects from './data/projects'
import * as releases from './data/releases'
import * as searches from './data/searches'
import * as settings from './data/settings'
import * as source from './data/source'
import * as status from './data/status'
import * as suggestions from './data/suggest'
import * as suspectsData from './data/suspects'
import * as tokens from './data/tokens'
import * as updates from './data/updates'
import * as widgets from './data/widgets'
import { PRIORITIES, type Priority } from './ingest/priority'
import { FILTER_LISTS, FILTER_SWITCHES, type Filters } from './ingest/filters'
import { sentryTarget } from './ingest/forward'
import { parseGroupingRules } from './ingest/rules'
import { botIdOf, telegramCall, telegramChats, telegramToken, type TelegramConfig } from './notify/channels'
import { type Metric, METRICS, metricQueryError, WINDOW_HOURS } from './notify/metrics'
import { LEVELS } from './notify/notice'
import { type Assertion, UPTIME_METHODS } from './monitors/monitors'
import { frequencyOf, INTERVALS, tagFilterError } from './notify/rules'
import { version } from '../package.json'
import { EVENT_KEYS, ISSUE_KEYS, issueFilter, type KeyInfo, LOG_KEYS } from './search/query'

const viewer = () => getRequestHeader('x-crashyard-viewer') ?? 'unknown'

// What the signed-in person may change, by role (src/auth/AGENTS.md): src/server.ts sets the role with the viewer.
// Every server function that changes something names the least role it needs; `fns.test.ts` fails on one that doesn't
const REFUSALS: Record<people.Role, string> = {
  viewer: 'Sign in to crashyard first.',
  member: 'Viewers can look but not change things. Ask an admin to make you a member.',
  admin: 'Only admins can do this. Ask an owner to make you an admin.',
  owner: 'Only owners can do this. Ask an owner if you need it.',
}
const role = () => {
  const r = getRequestHeader('x-crashyard-role')
  return people.isRole(r) ? r : null
}
const as = (needed: people.Role) =>
  createMiddleware({ type: 'function' }).server(({ next }) => {
    const r = role()
    if (!r || !people.reaches(r, needed)) throw new Error(REFUSALS[needed])
    return next()
  })
const signedIn = as('viewer')
const member = as('member')
const admin = as('admin')
const owner = as('owner')
const ZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC'])
const origin = () => new URL(getRequest().url).origin

// Input checks: what a page sends is untrusted until it's been through these
type Input = Record<string, unknown>
const object = (v: unknown): Input => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected an object')
  return v as Input
}
// A field a person types names itself, so its refusal says which and what fits: "Event retention in days is a whole
// number from 1 to 3,650." Fields only the page sets (ids, cursors) keep the short message: no one types them
const withCommas = (n: number) => n.toLocaleString('en-US')
const int = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER, name?: string) => {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max)
    throw new Error(
      name
        ? max === Number.MAX_SAFE_INTEGER
          ? `${name} is a whole number of ${withCommas(min)} or more.`
          : `${name} is a whole number from ${withCommas(min)} to ${withCommas(max)}.`
        : 'expected a whole number',
    )
  return n
}
const text = (v: unknown, max = 500, name?: string) => {
  if (typeof v !== 'string' || v.length > max)
    throw new Error(name ? `${name} is ${withCommas(max)} characters at most.` : 'expected text')
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

/** Where the overview opens, from the viewer's Settings, Preferences: a project that still exists and a range */
export const getHome = createServerFn().handler(async () => {
  const prefs = await settings.getPreferences(env.DB, viewer())
  const project = prefs.homeProject && (await projects.projectBySlug(env.DB, prefs.homeProject))
  return { project: project ? project.slug : undefined, days: prefs.homeRange ? Number(prefs.homeRange) : undefined }
})

// The sidebar: every project, the one picked last (a cookie it sets, only ever matched against the list), whether
// it was folded (shadcn's own cookie) and who's signed in, with their preferences. Times show in their chosen zone, else
// the browser's (a cookie the root's script keeps, `tz`), else UTC on a first visit; server and browser render the same.
export const getSidebar = createServerFn().handler(async () => {
  const browserZone = getCookie('tz')
  // Signed out, on a sign-in page: nothing of the deployment's, the browser's own theme
  if (!role())
    return {
      projects: [],
      lastProject: null,
      viewer: null,
      name: null,
      role: null,
      sidebarOpen: true,
      preferences: settings.PREFERENCES,
      zone: browserZone && ZONES.has(browserZone) ? browserZone : 'UTC',
    }
  const userId = Number(getRequestHeader('x-crashyard-user'))
  const [list, preferences, user] = await Promise.all([
    projects.allProjects(env.DB),
    settings.getPreferences(env.DB, viewer()),
    userId ? people.userById(env.DB, userId) : null,
  ])
  // The theme is the viewer's, the cookies the browser's: a browser that hasn't seen it yet gets it, from its next page
  if ((getCookie('theme') ?? 'system') !== preferences.theme) setThemeCookie('theme', preferences.theme)
  if ((getCookie('style') ?? 'hazard') !== preferences.style) setThemeCookie('style', preferences.style)
  return {
    projects: list,
    lastProject: getCookie('crashyard_project') ?? null,
    viewer: viewer(),
    name: user?.name ?? null,
    role: role(),
    sidebarOpen: getCookie('sidebar_state') !== 'false',
    preferences,
    zone: preferences.timeZone ?? (browserZone && ZONES.has(browserZone) ? browserZone : 'UTC'),
  }
})

export const createProject = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown) => {
    const o = object(d)
    return { name: text(o.name, 80, 'The project name').trim(), platform: oneOf(projects.PLATFORMS)(o.platform) }
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
    const [uploads, keys, filtered, workersSeen] = await Promise.all([
      tokens.uploadsOf(env.DB, project.id),
      projects.keysOf(env.DB, project.id, now),
      projects.filteredSince(env.DB, project.id, 30, now),
      projects.seenWorkers(env.DB),
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
      workersSeen,
      now,
    }
  })

// A project's settings: each page sends only its own fields, each checked as here
const limit = (name: string) => (v: unknown) => int(v, 0, 10_000_000, name)
const retention = (name: string) => (v: unknown) => int(v, 1, 3650, name)
// Their checks, shared with Defaults for new projects
const LIMITS = {
  daily_event_quota: limit('The daily event limit'),
  event_retention_days: retention('Event retention in days'),
  daily_log_quota: limit('The daily log limit'),
  log_retention_days: retention('Log retention in days'),
  daily_transaction_quota: limit('The daily transaction limit'),
}
const PROJECT_CHECKS: { [K in keyof projects.ProjectChange]-?: (v: unknown) => projects.ProjectChange[K] } = {
  name: (v) => {
    const name = text(v, 80, 'The project name').trim()
    if (!name) throw new Error('Give the project a name.')
    return name
  },
  slug: (v) => {
    const slug = text(v, 40, 'The slug').trim()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug))
      throw new Error('A slug is lowercase letters, numbers and dashes, and starts with a letter or number.')
    return slug
  },
  platform: oneOf(projects.PLATFORMS),
  ...LIMITS,
  repo_url: (v) => source.repoUrl(text(v ?? '', 300, 'The repository address')),
  auto_resolve_days: (v) => (v === null || v === '' ? null : int(v, 1, 3650, 'Days without events')),
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
  release_new_issues_max: (v) => (v === null || v === '' ? null : int(v, 0, 100_000, 'Most new issues')),
  // Cloudflare Workers by their script name, any spacing or commas between; null for none
  workers: (v) => {
    const names = [
      ...new Set(
        text(v ?? '', 2000, 'Workers to watch')
          .split(/[\s,]+/)
          .filter(Boolean),
      ),
    ]
    if (names.some((n) => !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(n)))
      throw new Error("A Worker's name is lowercase letters, numbers, dashes and underscores, as in its wrangler file.")
    if (names.length > 50) throw new Error('Watch 50 Workers at most.')
    return names.length ? JSON.stringify(names) : null
  },
  worker_exceptions: (v) => (v === true ? 1 : 0),
  // A Sentry DSN, tidied; null for none
  forward_dsn: (v) => {
    const dsn = text(v ?? '', 500, 'The Sentry DSN').trim()
    if (!dsn) return null
    const target = sentryTarget(dsn)
    if (!target)
      throw new Error(
        'That isn’t a DSN. Copy it from Sentry, under the project’s Client Keys. It looks like https://abc123@o1.ingest.sentry.io/42.',
      )
    return target.dsn
  },
  // Rules that don't parse are refused with the line and why, so ingest only ever reads good ones
  grouping_rules: (v) => {
    const rules = text(v ?? '', 20_000, 'The grouping rules')
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
  .middleware([admin])
  .validator((d: unknown) => {
    const o = object(d)
    const change: Record<string, unknown> = {}
    for (const [field, check] of Object.entries(PROJECT_CHECKS)) if (field in o) change[field] = check(o[field])
    return { id: int(o.id), change: change as projects.ProjectChange }
  })
  .handler(({ data }) => projects.updateProject(env.DB, data.id, data.change))

export const createKey = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown) => {
    const o = object(d)
    return { project: int(o.project), label: text(o.label ?? '', 80, 'The key name').trim() || 'Untitled' }
  })
  .handler(({ data }) => projects.createKey(env.DB, data.project, data.label, Date.now()).then(() => undefined))

export const updateKey = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown) => {
    const o = object(d)
    return {
      project: int(o.project),
      id: int(o.id),
      change: {
        label: text(o.label, 80, 'The key name').trim() || 'Untitled',
        enabled: o.enabled === true,
        daily_limit: optional((v) => int(v, 0, 10_000_000, 'The daily event limit'))(o.daily_limit) ?? null,
      },
    }
  })
  .handler(({ data }) => projects.updateKey(env.DB, data.project, data.id, data.change).then(() => undefined))

export const deleteProject = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => projects.deleteProject(env.DB, env.FILES, data.id).then(() => undefined))

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
      // Opened by a person: read until its next event
      who === 'unknown' ? undefined : issues.markViewed(env.DB, who, data.id, now),
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
  .middleware([member])
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
  .middleware([member])
  .validator((d: unknown) => ({ ids: ints(object(d).ids) }))
  .handler(({ data }) => issues.mergeIssues(env.DB, data.ids, viewer(), Date.now()))

export const assignIssue = createServerFn({ method: 'POST' })
  .middleware([member])
  .validator((d: unknown) => {
    const o = object(d)
    const assignee = optional((v) => text(v, 200).trim())(o.assignee) ?? null
    if (assignee !== null && !/^[^\s@]+@[^\s@]+$/.test(assignee)) throw new Error('Assign to an email address.')
    return { id: int(o.id), assignee }
  })
  .handler(({ data }) => issues.assignIssue(env.DB, data.id, data.assignee, viewer(), Date.now()))

export const bookmarkIssue = createServerFn({ method: 'POST' })
  .middleware([signedIn])
  .validator((d: unknown) => {
    const o = object(d)
    return { id: int(o.id), on: o.on === true }
  })
  .handler(({ data }) => issues.bookmarkIssue(env.DB, viewer(), data.id, data.on).then(() => undefined))

export const linkIssue = createServerFn({ method: 'POST' })
  .middleware([member])
  .validator((d: unknown) => {
    const o = object(d)
    const url = optional((v) => text(v, 500, 'The issue address').trim())(o.url) ?? null
    if (url !== null && !(URL.canParse(url) && /^https?:$/.test(new URL(url).protocol)))
      throw new Error('That isn’t a web address. Paste the issue’s link, starting with https://.')
    return { id: int(o.id), url }
  })
  .handler(({ data }) => issues.linkIssue(env.DB, data.id, data.url, viewer(), Date.now()))

export const getMergedFingerprints = createServerFn()
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => issues.mergedFingerprints(env.DB, data.id))

export const unmergeIssue = createServerFn({ method: 'POST' })
  .middleware([member])
  .validator((d: unknown) => {
    const o = object(d)
    return { id: int(o.id), fingerprint: text(o.fingerprint, 200) }
  })
  .handler(({ data }) => issues.unmergeIssue(env.DB, data.id, data.fingerprint, viewer(), Date.now()))

export const addNote = createServerFn({ method: 'POST' })
  .middleware([member])
  .validator((d: unknown) => {
    const o = object(d)
    return { id: int(o.id), text: text(o.text, 10_000, 'A note').trim() }
  })
  .handler(async ({ data }) => {
    if (data.text) await issues.addNote(env.DB, data.id, data.text, viewer(), Date.now())
  })

export const deleteNote = createServerFn({ method: 'POST' })
  .middleware([member])
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

// Explore: events across issues for a search, with columns, a chart and a group-by; `issue` scopes it to one issue
const exploreInput = (o: Input, project?: number): explore.ExploreInput => ({
  query: text(o.query ?? '', 2000),
  range: oneOf(['1h', '24h', '7d', '30d', 'all'] as const)(o.range ?? '24h'),
  projectId: project,
  issueId: optional((v) => int(v))(o.issue),
  columns: Array.isArray(o.columns)
    ? o.columns.slice(0, explore.MAX_COLUMNS).map((c) => {
        const column = text(c, 60)
        if (!/^[\w.:-]+$/.test(column)) throw new Error(`${column} isn’t a tag name.`)
        return column
      })
    : undefined,
  groupBy: optional((v) => text(v, 60))(o.groupBy),
  aggregate: oneOf(explore.AGGREGATES)(o.aggregate ?? 'count'),
  before: optional((v) => int(v))(o.before),
})

export const getExplore = createServerFn()
  .validator((d: unknown) => object(d))
  .handler(async ({ data: o }) => {
    const slug = optional((v) => text(v, 60))(o.project)
    const project = slug ? await projects.projectBySlug(env.DB, slug) : undefined
    const given = exploreInput(o, slug ? (project?.id ?? -1) : undefined)
    const input = { ...given, range: given.range === 'all' ? ('30d' as const) : given.range }
    const now = Date.now()
    const [events, chart] = await Promise.all([
      explore.exploreEvents(env.DB, input, now),
      explore.exploreChart(env.DB, input, now),
    ])
    return { ...events, chart, now }
  })

/** An issue's events for a search: the same as Explore, over every event it keeps */
export const getIssueEvents = createServerFn()
  .validator((d: unknown) => {
    const o = object(d)
    return exploreInput({ ...o, range: 'all', issue: int(o.issue) })
  })
  .handler(async ({ data }) => ({ ...(await explore.exploreEvents(env.DB, data, Date.now())), now: Date.now() }))

export const getTrace = createServerFn()
  .validator((d: unknown) => {
    const id = text(object(d).traceId, 64).toLowerCase()
    if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('A trace ID is 32 hexadecimal characters.')
    return { traceId: id }
  })
  .handler(async ({ data }) => ({
    ...(await explore.traceOf(env.DB, data.traceId)),
    traceId: data.traceId,
    now: Date.now(),
  }))

// A channel's secrets stay on the server: Telegram's webhook secret for everyone (saving finds it again), and the bot
// token and webhook address for anyone below admin, who can't edit channels anyway
const channelForPage = <C extends { config: string }>(channel: C, isAdmin: boolean): C => {
  const { secret: _, ...config } = JSON.parse(channel.config) as Record<string, unknown>
  if (!isAdmin) for (const key of ['token', 'url']) if (key in config) config[key] = ''
  return { ...channel, config: JSON.stringify(config) }
}

export const getNotifications = createServerFn().handler(async () => ({
  ...(await notifications.settings(env.DB).then((s) => {
    const r = role()
    return { ...s, channels: s.channels.map((c) => channelForPage(c, !!r && people.reaches(r, 'admin'))) }
  })),
  projects: await projects.allProjects(env.DB),
  emailFrom: env.EMAIL_FROM || null,
  now: Date.now(),
}))

const minuteOfDay = optional((v) => int(v, 0, 1439))
export const saveChannel = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown): notifications.ChannelInput => {
    const o = object(d)
    return {
      id: optional((v) => int(v))(o.id),
      kind: oneOf(['telegram', 'email', 'webhook'] as const)(o.kind),
      name: text(o.name, 80, 'The name').trim() || 'Untitled',
      config: json(o.config),
      quiet_from: minuteOfDay(o.quiet_from) ?? null,
      quiet_to: minuteOfDay(o.quiet_to) ?? null,
      quiet_zone:
        optional((v) => {
          const zone = text(v, 64)
          if (!ZONES.has(zone))
            throw new Error('That time zone for quiet hours isn’t known. Pick one in Settings, Preferences.')
          return zone
        })(o.quiet_zone) ?? null,
    }
  })
  .handler(async ({ data }) => {
    if (data.kind !== 'telegram') return notifications.saveChannel(env.DB, data, Date.now())
    // A Telegram channel's buttons act through the bot's webhook, which Telegram calls with the bot's secret; it needs
    // a public https address, so a local crashyard sends them without
    const config = JSON.parse(data.config) as TelegramConfig
    const bot = botIdOf(config.token)
    const base = env.PUBLIC_URL?.replace(/\/$/, '')
    const secret = base?.startsWith('https://')
      ? ((await notifications.telegramChannels(env.DB)).find((c) => botIdOf(c.token) === bot && c.secret)?.secret ??
        crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, ''))
      : undefined
    const saved: TelegramConfig = { ...config, secret, owner: viewer() }
    await notifications.saveChannel(env.DB, { ...data, config: JSON.stringify(saved) }, Date.now())
    if (secret)
      await telegramCall(saved, 'setWebhook', {
        url: `${base}/api/telegram/${bot}`,
        secret_token: secret,
        allowed_updates: ['callback_query'],
      }).catch((error: Error) => {
        throw new Error(`Saved, but its Resolve and Ignore buttons won’t work yet. ${error.message}`)
      })
  })

/** The chats that wrote to a Telegram bot lately, for its channel's chat */
export const findTelegramChats = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown) => {
    const token = telegramToken(text(object(d).token, 500))
    if (!token) throw new Error('That isn’t a bot token. Copy the token from @BotFather, it looks like 123456789:AA…')
    return { token }
  })
  .handler(async ({ data }) => {
    const chats = await telegramChats(data.token)
    // Reading them takes a bot's webhook off: put it back for its channels' buttons, as saving would
    const base = env.PUBLIC_URL?.replace(/\/$/, '')
    const bot = botIdOf(data.token)
    const known = (await notifications.telegramChannels(env.DB)).find((c) => botIdOf(c.token) === bot && c.secret)
    if (known && base?.startsWith('https://'))
      await telegramCall(known, 'setWebhook', {
        url: `${base}/api/telegram/${bot}`,
        secret_token: known.secret,
        allowed_updates: ['callback_query'],
      }).catch(() => {})
    return chats
  })

export const deleteChannel = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(async ({ data }) => {
    const telegram = await notifications.telegramChannels(env.DB)
    const gone = telegram.find((c) => c.id === data.id)
    await notifications.deleteChannel(env.DB, data.id)
    // The bot's last channel takes its webhook with it; Telegram's refusal changes nothing here
    if (gone?.secret && !telegram.some((c) => c.id !== gone.id && botIdOf(c.token) === botIdOf(gone.token)))
      await telegramCall(gone, 'deleteWebhook', {}).catch(() => {})
  })

export const saveRoute = createServerFn({ method: 'POST' })
  .middleware([admin])
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
    throw new Error('Releases are globs of 200 characters at most.')
  return list.length ? JSON.stringify(list) : null
}
// Tag filters, checked as they'll be matched
const routeQuery = (v: unknown) => {
  const query = text(v ?? '', 1000, 'The tag filter').trim()
  const error = query && tagFilterError(query)
  if (error) throw new Error(error)
  return query || null
}

export const saveMetricAlert = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown): notifications.MetricAlertInput => {
    const o = object(d)
    const metric = oneOf(Object.keys(METRICS) as Metric[])(o.metric)
    const query = text(o.query ?? '', 1000, 'The filter').trim()
    const error = metricQueryError(metric, query)
    if (error) throw new Error(error)
    const number = (v: unknown) => {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0)
        throw new Error('Give the values as numbers, 0 or more.')
      return n
    }
    const name = text(o.name, 80, 'The name').trim()
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
  .middleware([admin])
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => notifications.deleteMetricAlert(env.DB, data.id).then(() => undefined))

export const deleteRoute = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => notifications.deleteRoute(env.DB, data.id).then(() => undefined))

export const testRoute = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => notifications.testRoute(env, data.id, origin()))

export const testChannel = createServerFn({ method: 'POST' })
  .middleware([admin])
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
  if (from >= to || to - from > logs.MAX_SPAN)
    throw new Error('The start of the range comes before its end, 90 days apart at most.')
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
      scope: oneOf(['issues', 'logs', 'events'] as const)(o.scope),
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
          data.scope !== 'logs'
            ? await suggestions.issueValues(env.DB, data.key, data.prefix, projectId)
            : await suggestions.logValues(env.DB, data.key, data.prefix, projectId, since),
      }
    const builtIn = data.scope === 'issues' ? ISSUE_KEYS : data.scope === 'events' ? EVENT_KEYS : LOG_KEYS
    const names = new Set(builtIn.map((k) => k.key))
    const stored =
      data.scope !== 'logs'
        ? await suggestions.issueKeys(env.DB, projectId)
        : await suggestions.logKeys(env.DB, projectId, since)
    const what = data.scope !== 'logs' ? ['Tag', 'issue'] : ['Attribute', 'log']
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
  .middleware([signedIn])
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
  .middleware([member])
  .validator((d: unknown) => {
    const o = object(d)
    const name = text(o.name, 80, 'The dashboard name').trim()
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
  .middleware([member])
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
  .middleware([member])
  .validator((d: unknown) => {
    const o = object(d)
    return { id: int(o.id), widget: widgets.parseWidgets([o.widget])[0] }
  })
  .handler(({ data }) => dashboards.addWidget(env.DB, data.id, data.widget, viewer(), Date.now()))

export const deleteDashboard = createServerFn({ method: 'POST' })
  .middleware([member])
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => dashboards.deleteDashboard(env.DB, data.id).then(() => undefined))

// A token for one project (`project`, its id) or every project
export const createToken = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown) => {
    const o = object(d)
    return {
      name: text(o.name, 80, 'The token name').trim() || 'sentry-cli',
      project: optional((v) => int(v))(o.project) ?? null,
    }
  })
  .handler(({ data }) => tokens.createToken(env.DB, data.name, viewer(), Date.now(), data.project))

export const revokeToken = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => tokens.revokeToken(env.DB, data.id).then(() => undefined))

// An uptime check's header values and body may hold credentials (an Authorization header, a token in a POST): they
// stay on the server for anyone below admin, who can't edit monitors anyway, as channels' secrets do
const monitorForPage = <M extends { kind: string; config: string }>(monitor: M): M => {
  const r = role()
  if (monitor.kind !== 'uptime' || (r && people.reaches(r, 'admin'))) return monitor
  const config = JSON.parse(monitor.config) as { headers?: [string, string][]; body?: string }
  if (config.headers) config.headers = config.headers.map(([name]) => [name, ''])
  if (config.body) config.body = ''
  return { ...monitor, config: JSON.stringify(config) }
}

export const getMonitors = createServerFn().handler(async () => ({
  monitors: (await monitors.listMonitors(env.DB)).map(monitorForPage),
  projects: await projects.allProjects(env.DB),
  now: Date.now(),
}))

export const getMonitor = createServerFn()
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(async ({ data }) => {
    const monitor = await monitors.getMonitor(env.DB, data.id, Date.now())
    return monitor
      ? {
          ...monitor,
          monitor: monitorForPage(monitor.monitor),
          projects: await projects.allProjects(env.DB),
          statusPages: await status.pagesShowing(env.DB, monitor.monitor.id),
        }
      : null
  })

const httpUrl = (v: unknown) => {
  const s = text(v, 2000, 'The URL')
  if (!URL.canParse(s))
    throw new Error('That isn’t a URL. It starts with https://, such as https://api.example.com/health.')
  const u = new URL(s)
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('The URL must start with http:// or https://.')
  return u.toString()
}
// An uptime check's request headers, 20 at most, names as HTTP allows them
const uptimeHeaders = (v: unknown): [string, string][] | undefined => {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.length > 20) throw new Error('Keep it to 20 headers at most.')
  return v.map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error('expected a header name and value')
    const name = text(pair[0], 100, 'A header name').trim()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error(`${name || 'A header'} isn’t a header name.`)
    return [name, text(pair[1], 2000, 'A header value')]
  })
}

// What an uptime check's answer must be, 10 at most
const assertionsOf = (v: unknown): Assertion[] | undefined => {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.length > 10) throw new Error('Keep it to 10 assertions at most.')
  return v.map((raw): Assertion => {
    const a = object(raw)
    if (a.kind === 'status') {
      const codes = Array.isArray(a.in) ? a.in.map((x) => int(x, 100, 599, 'A status code')) : []
      if (!codes.length || codes.length > 20)
        throw new Error('Give the status codes it may answer, separated by commas, such as 200, 204. 20 at most.')
      return { kind: 'status', in: codes }
    }
    if (a.kind === 'header')
      return {
        kind: 'header',
        name: text(a.name, 100, 'A header name').trim(),
        contains: text(a.contains, 500, 'What a header contains'),
      }
    if (a.kind === 'json') {
      const path = text(a.path, 200, 'A JSON path').trim()
      if (!/^(\$\.?)?[\w-]+(\.[\w-]+|\[\d+\])*$/.test(path))
        throw new Error('A JSON path reads like $.status or $.checks[0].ok.')
      return { kind: 'json', path, equals: text(a.equals, 500, 'What a JSON path equals') }
    }
    throw new Error('expected a status, header or JSON assertion')
  })
}

export const saveMonitor = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown): monitors.MonitorInput => {
    const o = object(d)
    const c = object(o.config)
    const base = {
      id: optional((v) => int(v))(o.id),
      project_id: int(o.project_id),
      name: text(o.name, 100, 'The name').trim() || 'Untitled',
      slug: optional((v) => text(v, 100, 'The slug'))(o.slug),
      environment: text(o.environment ?? 'production', 64, 'The environment') || 'production',
      failure_threshold: int(o.failure_threshold ?? 1, 1, 100, 'Failures before an incident'),
      recovery_threshold: int(o.recovery_threshold ?? 1, 1, 100, 'Successes to recover'),
    }
    if (o.kind === 'uptime') {
      return {
        ...base,
        kind: 'uptime',
        config: {
          url: httpUrl(c.url),
          method: oneOf(UPTIME_METHODS)(c.method ?? 'GET'),
          headers: uptimeHeaders(c.headers),
          body: optional((v) => text(v, 10_000, 'The body'))(c.body),
          assertions: assertionsOf(c.assertions),
          expectedStatus: optional((v) => int(v, 100, 599, 'The status'))(c.expectedStatus),
          mustContain: optional((v) => text(v, 200, 'Response must contain'))(c.mustContain),
          intervalMinutes: int(c.intervalMinutes ?? 5, 1, 60, 'Interval in minutes'),
          // Sent in ms, typed in seconds
          timeoutMs: int(Number(c.timeoutMs ?? 10_000) / 1000, 1, 30, 'Timeout in seconds') * 1000,
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
                value: int(schedule.value, 1, 1000, 'Every'),
                unit: oneOf(['minute', 'hour', 'day', 'week', 'month', 'year'] as const)(schedule.unit),
              }
            : { type: 'crontab', value: text(schedule.value, 100, 'The crontab') },
        timezone: optional((v) => text(v, 64, 'The time zone'))(c.timezone),
        checkinMargin: optional((v) => int(v, 1, 1440, 'Grace period in minutes'))(c.checkinMargin),
        maxRuntime: optional((v) => int(v, 1, 1440, 'Maximum runtime in minutes'))(c.maxRuntime),
      },
    }
  })
  .handler(async ({ data }) => {
    if (data.kind === 'cron')
      (await import('./monitors/schedule')).nextRun(data.config.schedule, Date.now(), data.config.timezone)
    return monitors.saveMonitor(env.DB, data, Date.now())
  })

export const pauseMonitor = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown) => {
    const o = object(d)
    return { id: int(o.id), paused: o.paused === true }
  })
  .handler(({ data }) => monitors.setPaused(env.DB, data.id, data.paused, Date.now()))

// A page of a Sentry project's issues into a crashyard project (src/ingest/import.ts). The token comes with each call
// and is used for it only, never stored
export const importFromSentry = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown) => {
    const o = object(d)
    const base = text(o.base, 200, 'The Sentry address').trim().replace(/\/+$/, '')
    let url: URL
    try {
      url = new URL(base)
    } catch {
      throw new Error('The Sentry address is a web address, such as https://sentry.io.')
    }
    if (url.protocol !== 'https:') throw new Error('The Sentry address starts with https://.')
    const slug = (v: unknown, label: string) => {
      const s = text(v, 100, label).trim()
      if (!/^[\w.-]+$/.test(s))
        throw new Error(`${label} is letters, numbers, dashes, dots and underscores, as in Sentry.`)
      return s
    }
    const token = text(o.token, 500, 'The auth token').trim()
    if (!token) throw new Error('Paste a Sentry auth token.')
    return {
      project_id: int(o.project_id),
      source: {
        base: url.origin,
        token,
        org: slug(o.org, 'The organization slug'),
        project: slug(o.project, 'The project slug'),
      },
      cursor: optional((v) => text(v, 500))(o.cursor) ?? null,
    }
  })
  .handler(async ({ data }) => {
    const { importPage } = await import('./ingest/import')
    return importPage(env.DB, data.project_id, data.source, data.cursor)
  })

export const deleteMonitor = createServerFn({ method: 'POST' })
  .middleware([admin])
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
  .middleware([admin])
  .validator((d: unknown) => {
    const o = object(d)
    return { project: int(o.project), id: int(o.id) }
  })
  .handler(({ data }) => tokens.deleteDebugFile(env.DB, env.FILES, data.project, data.id))

export const getInstanceSettings = createServerFn().handler(async () => {
  const [defaults, scrubFields, update] = await Promise.all([
    settings.projectDefaults(env.DB),
    settings.getSetting<string[]>(env.DB, settings.SCRUB_KEY, []),
    updates.update(),
  ])
  return {
    origin: origin(),
    publicUrl: env.PUBLIC_URL || null,
    defaults,
    scrubFields,
    version,
    update,
  }
})

export const saveProjectDefaults = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown): settings.ProjectDefaults => {
    const o = object(d)
    return {
      daily_event_quota: LIMITS.daily_event_quota(o.daily_event_quota),
      daily_log_quota: LIMITS.daily_log_quota(o.daily_log_quota),
      daily_transaction_quota: LIMITS.daily_transaction_quota(o.daily_transaction_quota),
      event_retention_days: LIMITS.event_retention_days(o.event_retention_days),
      log_retention_days: LIMITS.log_retention_days(o.log_retention_days),
    }
  })
  .handler(({ data }) => settings.setSetting(env.DB, 'defaults.project', data, viewer()).then(() => undefined))

export const saveScrubFields = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown) => {
    const list = object(d).fields
    if (!Array.isArray(list) || list.length > 100) throw new Error('Keep it to 100 field names at most.')
    return { fields: [...new Set(list.map((f) => text(f, 80, 'A field name').trim()).filter(Boolean))] }
  })
  .handler(({ data }) => settings.setSetting(env.DB, settings.SCRUB_KEY, data.fields, viewer()).then(() => undefined))

export const getTokens = createServerFn().handler(async () => ({
  tokens: await tokens.listTokens(env.DB),
  projects: await projects.allProjects(env.DB),
  now: Date.now(),
}))

export const getUsage = createServerFn()
  .validator((d: unknown) => ({ project: optional((v) => text(v, 60))(object(d).project) }))
  .handler(async ({ data }) => health.usage(env.DB, await projectIdOf(data.project), 30, Date.now()))

// The Cloudflare plan, for the pages whose features need Workers Paid: probed in this request, its own invocation, at
// most once a day unless asked again (src/data/plan.ts)
export const getPlan = createServerFn({ method: 'POST' })
  .middleware([signedIn])
  .validator((d: unknown) => ({ fresh: object(d ?? {}).fresh === true }))
  .handler(async ({ data }) => (await import('./data/plan')).planOf(env.DB, Date.now(), data.fresh))

export const getHealth = createServerFn().handler(async () => {
  const now = Date.now()
  return { ...(await health.health(env, now)), now }
})

const PREFERENCE_CHECKS: { [K in keyof settings.Preferences]-?: (v: unknown) => settings.Preferences[K] | undefined } =
  {
    theme: oneOf(['system', 'light', 'dark'] as const),
    style: oneOf(settings.STYLES),
    timeZone: optional((v) => {
      const zone = text(v, 64)
      if (!ZONES.has(zone)) throw new Error('That time zone isn’t known. Pick one from the list.')
      return zone
    }),
    clock: oneOf(['24', '12'] as const),
    stackOrder: oneOf(['newest', 'oldest'] as const),
    showOtherFrames: (v) => v === true,
    homeProject: optional((v) => text(v, 60)),
    homeRange: optional(oneOf(['14', '30', '90'] as const)),
  }

/** One preference of the viewer's; the theme and style go in cookies too, for the script that sets them before paint */
export const savePreference = createServerFn({ method: 'POST' })
  .middleware([signedIn])
  .validator((d: unknown) => {
    const o = object(d)
    const key = oneOf(Object.keys(PREFERENCE_CHECKS) as (keyof settings.Preferences)[])(o.key)
    return { key, value: PREFERENCE_CHECKS[key](o.value) }
  })
  .handler(async ({ data }) => {
    await settings.setPreference(env.DB, viewer(), data.key, data.value)
    if (data.key === 'theme' || data.key === 'style') setThemeCookie(data.key, String(data.value))
  })

const setThemeCookie = (name: 'theme' | 'style', value: string) =>
  setCookie(name, value, { path: '/', maxAge: 31_536_000, sameSite: 'lax', secure: true })

// Saved searches of a page: the viewer's own and everyone's shared ones, the viewer's pinned one first
export const getSavedSearches = createServerFn()
  .validator((d: unknown) => ({ page: oneOf(searches.PAGES)(object(d).page) }))
  .handler(({ data }) => searches.listSavedSearches(env.DB, viewer(), data.page))

export const saveSearch = createServerFn({ method: 'POST' })
  .middleware([signedIn])
  .validator((d: unknown) => {
    const o = object(d)
    const name = text(o.name, 80, 'The search name').trim()
    if (!name) throw new Error('Give the search a name.')
    return {
      page: oneOf(searches.PAGES)(o.page),
      name,
      query: text(o.query ?? '', 1000, 'The search'),
      shared: o.shared === true,
    }
  })
  .handler(({ data }) => searches.saveSearch(env.DB, viewer(), data, Date.now()))

export const pinSearch = createServerFn({ method: 'POST' })
  .middleware([signedIn])
  .validator((d: unknown) => {
    const o = object(d)
    return { id: int(o.id), pinned: o.pinned === true }
  })
  .handler(({ data }) => searches.pinSearch(env.DB, viewer(), data.id, data.pinned))

export const deleteSearch = createServerFn({ method: 'POST' })
  .middleware([signedIn])
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => searches.deleteSearch(env.DB, viewer(), data.id))

// Sign-in (src/auth/AGENTS.md): the signed-in person's passkeys, sessions and recovery codes, Settings, Account; and
// People, the owners' page

/** The signed-in person's id; none on a dev server signed in as dev@localhost */
const me = () => {
  const id = Number(getRequestHeader('x-crashyard-user'))
  if (!id) throw new Error('Sign in with a passkey first. A dev server does with AUTH=crashyard pnpm dev.')
  return id
}

export const getSignIn = createServerFn()
  .middleware([signedIn])
  .handler(async () => {
    const id = Number(getRequestHeader('x-crashyard-user'))
    const now = Date.now()
    // A dev server's dev@localhost has none of these
    if (!id) return { viewer: viewer(), passkeys: [], sessions: [], codesLeft: 0, now }
    const current = getRequestHeader('x-crashyard-session')
    const [passkeys, sessions, codesLeft] = await Promise.all([
      people.passkeysOf(env.DB, id),
      people.sessionsOf(env.DB, id, now),
      people.recoveryCodesLeft(env.DB, id),
    ])
    return {
      viewer: viewer(),
      passkeys,
      sessions: sessions.map((s) => ({ ...s, current: s.hash === current })),
      codesLeft,
      now,
    }
  })

export const renamePasskey = createServerFn({ method: 'POST' })
  .middleware([signedIn])
  .validator((d: unknown) => {
    const o = object(d)
    const name = text(o.name, 60, 'The passkey name').trim()
    if (!name) throw new Error('Give the passkey a name.')
    return { id: text(o.id, 1000), name }
  })
  .handler(async ({ data }) => {
    await people.renamePasskey(env.DB, me(), data.id, data.name)
  })

export const removePasskey = createServerFn({ method: 'POST' })
  .middleware([signedIn])
  .validator((d: unknown) => ({ id: text(object(d).id, 1000) }))
  .handler(({ data }) => people.removePasskey(env.DB, me(), data.id))

export const signOutSession = createServerFn({ method: 'POST' })
  .middleware([signedIn])
  .validator((d: unknown) => {
    const o = object(d)
    return { hash: o.others === true ? null : text(o.hash, 64) }
  })
  .handler(async ({ data }) => {
    const current = getRequestHeader('x-crashyard-session') ?? ''
    if (data.hash === null) await people.endOtherSessions(env.DB, me(), current)
    else await people.endSessionOf(env.DB, me(), data.hash)
  })

export const makeRecoveryCodes = createServerFn({ method: 'POST' })
  .middleware([signedIn])
  .handler(() => people.newRecoveryCodes(env.DB, me()))

export const getPeople = createServerFn()
  .middleware([owner])
  .handler(async () => {
    const now = Date.now()
    const [users, invites, app] = await Promise.all([
      people.listUsers(env.DB),
      people.listInvites(env.DB, now),
      gitHubApp(env.DB),
    ])
    return {
      users,
      invites,
      me: Number(getRequestHeader('x-crashyard-user')) || null,
      github: app && { slug: app.slug, owner: app.owner },
      now,
    }
  })

export const createInvite = createServerFn({ method: 'POST' })
  .middleware([owner])
  .validator((d: unknown) => {
    const o = object(d)
    const email = text(o.email ?? '', 200, 'The email')
      .trim()
      .toLowerCase()
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new Error('That email doesn’t look right. It should look like someone@example.com.')
    return { role: oneOf(people.ROLES)(o.role), email: email || null }
  })
  .handler(async ({ data }) => {
    if (data.email && (await people.userByEmail(env.DB, data.email)))
      throw new Error('Someone with that email is already here.')
    const token = await people.createInvite(env.DB, data.role, data.email, viewer(), Date.now())
    return `${env.PUBLIC_URL?.replace(/\/$/, '') || origin()}/invite/${token}`
  })

export const revokeInvite = createServerFn({ method: 'POST' })
  .middleware([owner])
  .validator((d: unknown) => ({ hash: text(object(d).hash, 64) }))
  .handler(async ({ data }) => {
    await people.revokeInvite(env.DB, data.hash)
  })

export const changeRole = createServerFn({ method: 'POST' })
  .middleware([owner])
  .validator((d: unknown) => {
    const o = object(d)
    return { id: int(o.id), role: oneOf(people.ROLES)(o.role) }
  })
  .handler(({ data }) => people.changeRole(env.DB, data.id, data.role))

export const removePerson = createServerFn({ method: 'POST' })
  .middleware([owner])
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => {
    if (data.id === me()) throw new Error('You can’t remove yourself. Ask another owner to do it.')
    return people.removeUser(env.DB, data.id)
  })

// The sign-in pages' own data, read while signed out (only during their server render: src/server.ts answers 401 to a
// server function call from a signed-out browser), so they say nothing about the deployment beyond what the page needs

export const getSignInPage = createServerFn().handler(async () => ({ github: !!(await gitHubApp(env.DB)) }))

// A status page, read while signed out as the sign-in pages are: only the uptime checks on it, by name, never their
// addresses (src/data/status.ts statusPage)
export const getStatusPage = createServerFn()
  .validator((d: unknown) => ({ slug: text(object(d).slug, 60) }))
  .handler(({ data }) => status.statusPage(env.DB, data.slug, Date.now()))

// What a status page shows and says, for the team
export const getStatusPosts = createServerFn()
  .middleware([signedIn])
  .validator((d: unknown) => ({ slug: text(object(d).slug, 60) }))
  .handler(async ({ data }) => {
    const page = await status.pageOf(env.DB, data.slug)
    if (!page) return null
    const now = Date.now()
    return {
      page,
      checks: await status.checksOf(env.DB, page.id),
      posts: await status.postsOf(env.DB, page.id, now),
      now,
    }
  })

export const getStatusPages = createServerFn()
  .middleware([signedIn])
  .handler(() => status.pagesOf(env.DB, Date.now()))

const pageName = (v: unknown) => {
  const name = text(v, 80, 'The name').trim()
  if (!name) throw new Error('Give the status page a name.')
  return name
}

export const createStatusPage = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown) => ({ name: pageName(object(d).name) }))
  .handler(({ data }) => status.createPage(env.DB, data.name, Date.now()))

// A status page's own fields, each checked as the person typed it
const STATUS_PAGE_CHECKS: { [K in keyof status.PageChange]-?: (v: unknown) => status.PageChange[K] } = {
  name: pageName,
  slug: (v) => {
    const slug = text(v, 40, 'The address').trim()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug))
      throw new Error('An address is lowercase letters, numbers and dashes, and starts with a letter or number.')
    return slug
  },
  // The look: each part optional, addresses only https, a colour as #rrggbb
  branding: (v) => {
    const o = object(v)
    const https = (x: unknown, name: string) => {
      const s = text(x ?? '', 500, name).trim()
      if (s && !/^https:\/\/[^\s"'<>]+$/.test(s)) throw new Error(`${name} starts with https://.`)
      return s
    }
    const b = {
      title: text(o.title ?? '', 80, 'The page title').trim(),
      description: text(o.description ?? '', 500, 'The description').trim(),
      logo: https(o.logo, 'The logo address'),
      color: text(o.color ?? '', 7, 'The brand colour')
        .trim()
        .toLowerCase(),
      website: https(o.website, 'The website address'),
    }
    if (b.color && !/^#[0-9a-f]{6}$/.test(b.color))
      throw new Error('The brand colour is a hex colour, such as #f97316.')
    const set = Object.fromEntries(Object.entries(b).filter(([, x]) => x))
    return Object.keys(set).length ? JSON.stringify(set) : null
  },
  // A hostname of the deployment's Cloudflare account, never the dashboard's own
  domain: (v) => {
    const host = text(v ?? '', 253, 'The domain')
      .trim()
      .toLowerCase()
      .replace(/\.$/, '')
    if (!host) return null
    if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host))
      throw new Error('The domain is a hostname such as status.example.com, without https:// or a path.')
    if (env.PUBLIC_URL && host === new URL(env.PUBLIC_URL).hostname)
      throw new Error('That’s crashyard’s own address. Use a different hostname for the status page.')
    return host
  },
}

export const updateStatusPage = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown) => {
    const o = object(d)
    const change: Record<string, unknown> = {}
    for (const [field, check] of Object.entries(STATUS_PAGE_CHECKS)) if (field in o) change[field] = check(o[field])
    return { id: int(o.id), change: change as status.PageChange }
  })
  .handler(({ data }) => status.updatePage(env.DB, data.id, data.change))

export const setStatusPageCheck = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown) => {
    const o = object(d)
    return { page: int(o.page), monitor: int(o.monitor), on: o.on === true }
  })
  .handler(({ data }) => status.setCheck(env.DB, data.page, data.monitor, data.on).then(() => undefined))

export const deleteStatusPage = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => status.deletePage(env.DB, data.id).then(() => undefined))

const statusMessage = (v: unknown) => {
  const m = text(v, 5000, 'The message').trim()
  if (!m) throw new Error('Write a message to post.')
  return m
}

export const createStatusPost = createServerFn({ method: 'POST' })
  .middleware([member])
  .validator((d: unknown) => {
    const o = object(d)
    const impact = oneOf(Object.keys(status.IMPACTS) as status.Impact[])(o.impact)
    const title = text(o.title, 120, 'The title').trim()
    if (!title) throw new Error('Give it a title.')
    const maintenance = impact === 'maintenance'
    const starts = maintenance ? int(o.starts, 0, Number.MAX_SAFE_INTEGER, 'The start') : null
    const ends = maintenance ? int(o.ends, 0, Number.MAX_SAFE_INTEGER, 'The end') : null
    if (starts !== null && ends! <= starts) throw new Error('Maintenance ends after it starts. Check both times.')
    return {
      page: int(o.page),
      title,
      impact,
      state: oneOf(status.STATES_FOR[impact])(o.state),
      message: statusMessage(o.message),
      starts,
      ends,
      monitors: ints(o.monitors ?? [], 100),
    }
  })
  .handler(({ data: { page, ...post } }) => status.createPost(env.DB, page, post, viewer(), Date.now()))

export const addStatusUpdate = createServerFn({ method: 'POST' })
  .middleware([member])
  .validator((d: unknown) => {
    const o = object(d)
    return {
      id: int(o.id),
      state: text(o.state, 20),
      message: statusMessage(o.message),
      monitors: o.monitors === undefined ? undefined : ints(o.monitors, 100),
    }
  })
  .handler(async ({ data }) => {
    const post = await status.postOf(env.DB, data.id)
    if (!post) throw new Error('That post was deleted.')
    const state = oneOf(status.STATES_FOR[post.impact])(data.state)
    await status.addUpdate(env.DB, post.id, state, data.message, viewer(), Date.now(), data.monitors)
  })

export const deleteStatusPost = createServerFn({ method: 'POST' })
  .middleware([admin])
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(({ data }) => status.deletePost(env.DB, data.id).then(() => undefined))

// Before anyone is set up, the Workers plan too, so the owner knows from the start what needs Paid
export const getSetupPage = createServerFn().handler(async () => {
  const done = (await people.userCount(env.DB)) > 0
  return {
    ready: !!env.SETUP_CODE,
    done,
    plan: done ? null : await (await import('./data/plan')).planOf(env.DB, Date.now()),
  }
})

export const getInvitePage = createServerFn()
  .validator((d: unknown) => ({ token: text(object(d).token, 100) }))
  .handler(async ({ data }) => {
    const invite = await people.inviteOf(env.DB, data.token, Date.now())
    return (
      invite && {
        inviter: invite.inviter,
        role: invite.role,
        email: invite.email,
        usable: invite.usable,
        github: !!(await gitHubApp(env.DB)),
      }
    )
  })

// Agent tokens: a person's `cyp_` tokens for MCP, acting as them as far as the token's scope goes

export const getAgentTokens = createServerFn()
  .middleware([signedIn])
  .handler(async () => ({
    tokens: await people.userTokensOf(env.DB, me()),
    mcp: `${env.PUBLIC_URL?.replace(/\/$/, '') || origin()}/mcp`,
    now: Date.now(),
  }))

export const createAgentToken = createServerFn({ method: 'POST' })
  .middleware([signedIn])
  .validator((d: unknown) => {
    const o = object(d)
    const name = text(o.name, 80, 'The token name').trim()
    if (!name) throw new Error('Give the token a name, such as the agent or machine that uses it.')
    return {
      name,
      scope: oneOf(['read', 'change'] as const)(o.scope),
      days: o.days === null ? null : Number(oneOf(['30', '90', '365'] as const)(String(o.days))),
    }
  })
  .handler(({ data }) => {
    const now = Date.now()
    return people.createUserToken(env.DB, me(), data.name, data.scope, data.days ? now + data.days * 864e5 : null, now)
  })

export const revokeAgentToken = createServerFn({ method: 'POST' })
  .middleware([signedIn])
  .validator((d: unknown) => ({ id: int(object(d).id) }))
  .handler(async ({ data }) => {
    await people.revokeUserToken(env.DB, me(), data.id)
  })

// Sign in with GitHub (src/auth/github.ts): the owner creates the GitHub App from a manifest, and can remove it

export const startGitHubApp = createServerFn({ method: 'POST' })
  .middleware([owner])
  .validator((d: unknown) => {
    const org = text(object(d).org ?? '', 39, 'The organization').trim()
    if (org && !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(org))
      throw new Error('That isn’t a GitHub organization name. Copy it from the organization’s address on GitHub.')
    return { org: org || null }
  })
  .handler(({ data }) =>
    startApp(env.DB, env.PUBLIC_URL?.replace(/\/$/, '') || origin(), data.org, viewer(), Date.now()),
  )

export const removeGitHub = createServerFn({ method: 'POST' })
  .middleware([owner])
  .handler(async () => {
    await settings.setSetting(env.DB, GITHUB_KEY, null, viewer(), Date.now())
  })
