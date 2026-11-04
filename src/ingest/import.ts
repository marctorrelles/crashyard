// Importing a Sentry project's issues: each issue's latest event, as Sentry stored it, goes through the same steps as
// one the SDK sends (normalised, grouped by this project's rules, stored), so the SDK's next events of it come to the
// same issue; then the issue takes Sentry's count, first and last seen, users and resolved or ignored state, and its
// comments as notes. No notices: an import isn't news. A page of issues at a time, the browser asking for the next,
// as each issue costs about a dozen subrequests (3 to Sentry, the rest D1): 10 a page on Workers Paid, 2 on Free or
// a plan not known yet, within Free's 50 (src/data/plan.ts).
import { type Plan, PLAN_KEY } from '../data/plan'
import { getSetting } from '../data/settings'
import { normalizeEvent } from './event'
import { loadExtraFields } from './scrub'
import { groupingFor, type Project, storeEvent } from './store'

export const PAGE = 10
const FREE_PAGE = 2

export type SentrySource = { base: string; token: string; org: string; project: string }

type Json = Record<string, unknown>

/** A Sentry API call; a refusal or an outage as a sentence that says what to do */
async function sentry<T>(source: SentrySource, path: string): Promise<{ body: T; headers: Headers }> {
  let response: Response
  try {
    response = await fetch(new URL(path, source.base), {
      headers: { authorization: `Bearer ${source.token}`, accept: 'application/json' },
    })
  } catch {
    throw new Error(`crashyard couldn’t reach ${new URL(source.base).host}. Check the Sentry address.`)
  }
  if (response.status === 401 || response.status === 403)
    throw new Error('Sentry refused the token. Create one with the event:read and project:read scopes.')
  if (response.status === 404)
    throw new Error(`Sentry has no project ${source.org}/${source.project}, or the token can’t see it. Check both.`)
  if (response.status === 429) throw new Error('Sentry asked to slow down. Wait a minute, then continue the import.')
  if (!response.ok) throw new Error('Sentry didn’t answer as expected. Try again in a minute.')
  return { body: (await response.json()) as T, headers: response.headers }
}

/** The `next` cursor of Sentry's Link header, when there are more results */
export function nextCursor(link: string | null) {
  const next = link?.split(',').find((part) => /rel="next"/.test(part))
  return next && /results="true"/.test(next) ? (next.match(/cursor="([^"]+)"/)?.[1] ?? null) : null
}

type SentryIssue = {
  id: string
  count: string
  userCount: number
  firstSeen: string
  lastSeen: string
  status: string
  numComments?: number
}
type SentryNote = { dateCreated: string; data?: { text?: string }; user?: { email?: string; name?: string } | null }

const seg = encodeURIComponent

/** One page of the Sentry project's issues, every status, imported; `next` is the cursor to ask for, or null at the end */
export async function importPage(db: D1Database, projectId: number, source: SentrySource, cursor: string | null) {
  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).first<Project>()
  if (!project) throw new Error('That project no longer exists.')
  await loadExtraFields(db)
  const size = (await getSetting<Plan | null>(db, PLAN_KEY, null))?.paid === true ? PAGE : FREE_PAGE
  const { org, project: slug } = source
  const list = await sentry<SentryIssue[]>(
    source,
    `/api/0/projects/${seg(org)}/${seg(slug)}/issues/?query=&statsPeriod=&limit=${size}${cursor ? `&cursor=${seg(cursor)}` : ''}`,
  )
  const known = new Set(
    (
      await db
        .prepare(
          'SELECT sentry_issue_id FROM sentry_imports WHERE project_id = ? AND sentry_issue_id IN (SELECT value FROM json_each(?))',
        )
        .bind(projectId, JSON.stringify(list.body.map((i) => i.id)))
        .all<{ sentry_issue_id: string }>()
    ).results.map((r) => r.sentry_issue_id),
  )
  let imported = 0
  for (const issue of list.body) {
    if (known.has(issue.id)) continue
    const latest = await sentry<{ eventID: string }>(
      source,
      `/api/0/organizations/${seg(org)}/issues/${seg(issue.id)}/events/latest/`,
    )
    // The event as Sentry stored it, the shape the SDKs send, rather than its API's
    const raw = await sentry<Json>(
      source,
      `/api/0/projects/${seg(org)}/${seg(slug)}/events/${seg(latest.body.eventID)}/json/`,
    )
    const lastSeen = Date.parse(issue.lastSeen)
    const event = await normalizeEvent(raw.body, Number.isFinite(lastSeen) ? lastSeen : Date.now(), latest.body.eventID)
    const { fingerprint, version } = await groupingFor(db, project, event, Date.now())
    const stored = await storeEvent(db, project, event, fingerprint, version)
    // Imported before, under another project or by a run that stopped halfway: the issue its event is in
    const issueId =
      stored?.issue.id ??
      (await db.prepare('SELECT issue_id FROM events WHERE id = ?').bind(event.id).first<{ issue_id: number }>())
        ?.issue_id
    if (!issueId) continue
    const notes = issue.numComments
      ? (await sentry<SentryNote[]>(source, `/api/0/organizations/${seg(org)}/issues/${seg(issue.id)}/comments/`)).body
      : []
    const status = issue.status === 'resolved' ? 'resolved' : issue.status === 'ignored' ? 'ignored' : 'unresolved'
    await db.batch([
      // Sentry's numbers, the latest event already counted once; an issue that had events here keeps them
      db
        .prepare(
          `UPDATE issues SET count = count + ?, first_seen = MIN(first_seen, ?), last_seen = MAX(last_seen, ?),
             user_count = MAX(user_count, ?), status = ?,
             substatus = CASE ? WHEN 'ignored' THEN 'for_good' WHEN 'unresolved' THEN 'ongoing' END
           WHERE id = ?`,
        )
        .bind(
          stored?.stored ? Math.max(0, Number(issue.count) - 1) : 0,
          Date.parse(issue.firstSeen) || Date.now(),
          lastSeen || Date.now(),
          issue.userCount ?? 0,
          status,
          status,
          issueId,
        ),
      ...notes
        .filter((n) => n.data?.text)
        .map((n) =>
          db
            .prepare("INSERT INTO issue_activity (issue_id, kind, data, by, at) VALUES (?, 'note', ?, ?, ?)")
            .bind(
              issueId,
              JSON.stringify({ text: n.data!.text }),
              `${n.user?.email ?? n.user?.name ?? 'Someone'} on Sentry`,
              Date.parse(n.dateCreated) || Date.now(),
            ),
        ),
      db
        .prepare('INSERT OR IGNORE INTO sentry_imports (project_id, sentry_issue_id, issue_id, at) VALUES (?, ?, ?, ?)')
        .bind(projectId, issue.id, issueId, Date.now()),
    ])
    imported++
  }
  return { imported, skipped: list.body.length - imported, next: nextCursor(list.headers.get('link')) }
}
