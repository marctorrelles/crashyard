// Writing an event: its issue (made, counted, reopened), the event itself, its tags and the counts, in one D1 batch.
import { eventJson } from './budget'
import type { NormalizedEvent } from './event'
import { GROUPING_VERSION, type Hasher, HASHERS } from './grouping'
import { priorityFor } from './priority'
import { applyRules, rulesOf } from './rules'

export type Project = {
  id: number
  slug: string
  name: string
  daily_event_quota: number
  daily_log_quota: number
  daily_transaction_quota: number
  priorities?: string | null // JSON, a new issue's priority by level; null for PRIORITY_BY_LEVEL
  grouping_rules?: string | null // src/ingest/rules.ts
  grouping_version?: number
  grouping_previous?: number | null
  grouping_until?: number | null
  filters?: string | null // JSON, src/ingest/filters.ts
}

/** How long a project computes the grouping before a new version as well, so open issues keep their events */
export const GROUPING_OVERLAP = 30 * 86_400_000

/**
 * An event's fingerprint as the project groups it: its grouping rules (stack rules set in-app on the event itself),
 * then `groupingOf`. Ingest and reprocessing both come through here, so a late debug file keeps the project's rules
 */
export const groupingFor = (db: D1Database, project: Project, event: NormalizedEvent, now: number) =>
  groupingOf(db, project, applyRules(event, rulesOf(project.grouping_rules)), now)

/**
 * The fingerprint of an event, as grouping sees it, at the current grouping version. The first event of a project
 * at a new version records the one before and until when; until then the old hash is computed too, and an issue
 * that holds it gets the new one in `issue_fingerprints`, so its events keep coming to it
 */
export async function groupingOf(
  db: D1Database,
  project: Project,
  grouping: NormalizedEvent,
  now: number,
  hashers: Record<number, Hasher> = HASHERS,
  current = GROUPING_VERSION,
): Promise<{ fingerprint: string; version: number }> {
  const was = project.grouping_version ?? 1
  if (was !== current) {
    await db
      .prepare(
        `UPDATE projects SET grouping_previous = grouping_version, grouping_version = ?, grouping_until = ?
         WHERE id = ? AND grouping_version = ?`,
      )
      .bind(current, now + GROUPING_OVERLAP, project.id, was)
      .run()
    // The cached row too, so the next events of this isolate don't write it again
    Object.assign(project, {
      grouping_version: current,
      grouping_previous: was,
      grouping_until: now + GROUPING_OVERLAP,
    })
  }
  const fingerprint = await hashers[current](grouping)
  const previous = project.grouping_previous
  if (previous && previous !== current && hashers[previous] && now < (project.grouping_until ?? 0)) {
    const old = await hashers[previous](grouping)
    if (old !== fingerprint)
      await db
        .prepare(
          `INSERT OR IGNORE INTO issue_fingerprints (project_id, fingerprint, issue_id)
           SELECT ?1, ?2, id FROM issues WHERE id = COALESCE(
             (SELECT issue_id FROM issue_fingerprints WHERE project_id = ?1 AND fingerprint = ?3),
             (SELECT id FROM issues WHERE project_id = ?1 AND fingerprint = ?3))
           AND NOT EXISTS (SELECT 1 FROM issues WHERE project_id = ?1 AND fingerprint = ?2)`,
        )
        .bind(project.id, fingerprint, old)
        .run()
  }
  return { fingerprint, version: current }
}

type IssueRow = {
  id: number
  status: string
  substatus: string | null
  resolved_in_release: string | null
  fixed_in_release: string | null
  ignore_until_count: number | null
  ignore_until: number | null
  ignore_until_users: number | null
  count: number
  user_count: number
  minute: number
  minute_count: number
  title: string
  culprit: string
  level: string
}

/** What happened to the issue, for notifications */
export type Stored = {
  issue: { id: number; title: string; culprit: string; level: string; count: number }
  isNew: boolean
  transition?: 'regressed' | 'ignore_expired'
  countBefore: number
  stored: boolean // false when spike protection counted the event without keeping it
}

/** Events of one issue in one minute past which they're counted but not kept */
export const SPIKE_LIMIT = 60
/** Values of a tag kept per issue; the rest count as `other` */
export const TAG_VALUES = 100
const OTHER_TAG_VALUE = 'other'

export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** Whether a resolved or ignored issue opens again with this event */
export function transitionOf(
  issue: IssueRow,
  release: string | undefined,
  now: number,
  newUser = false,
  olderThanFix = false,
): Stored['transition'] {
  if (issue.status === 'resolved' && issue.fixed_in_release !== null) {
    // Resolved in a release: its events and a newer release's reopen it, an older one's and one naming none don't
    if (release && (release === issue.fixed_in_release || !olderThanFix)) return 'regressed'
    return undefined
  }
  if (issue.status === 'resolved') {
    // Resolved now: any new event is a regression. Resolved in the next release: an event from another release is; an
    // event that names no release can't say, so it isn't.
    if (issue.resolved_in_release === null) return 'regressed'
    if (release && release !== issue.resolved_in_release) return 'regressed'
  }
  if (issue.status === 'ignored') {
    if (issue.ignore_until_count !== null && issue.count + 1 >= issue.ignore_until_count) return 'ignore_expired'
    if (issue.ignore_until !== null && now >= issue.ignore_until) return 'ignore_expired'
    if (issue.ignore_until_users !== null && newUser && issue.user_count + 1 >= issue.ignore_until_users)
      return 'ignore_expired'
  }
  return undefined
}

/**
 * Whether an event's release is older than the one its resolved issue was fixed in: by the release's created_at
 * (sentry-cli's), else its first event; a release with neither is new. Read only for such an issue and another release
 */
async function olderThan(db: D1Database, projectId: number, issue: IssueRow, release: string | undefined, now: number) {
  if (issue.status !== 'resolved' || !issue.fixed_in_release || !release || release === issue.fixed_in_release)
    return false
  const first = (version: number) =>
    `COALESCE((SELECT created_at FROM releases WHERE project_id = ?1 AND version = ?${version}),
       (SELECT MIN(received) FROM events WHERE project_id = ?1 AND release = ?${version}), ?4)`
  const row = await db
    .prepare(`SELECT ${first(2)} < ${first(3)} AS older`)
    .bind(projectId, release, issue.fixed_in_release, now)
    .first<{ older: number }>()
  return !!row?.older
}

const ISSUE_COLUMNS =
  'id, status, substatus, resolved_in_release, fixed_in_release, ignore_until_count, ignore_until, ignore_until_users, count, user_count, minute, minute_count, title, culprit, level'

export async function storeEvent(
  db: D1Database,
  project: Project,
  event: NormalizedEvent,
  fingerprint: string,
  envelopeKey?: string,
  groupingVersion = GROUPING_VERSION,
): Promise<Stored | null> {
  if (await db.prepare('SELECT 1 FROM events WHERE id = ?').bind(event.id).first()) return null // sent twice

  const find = () =>
    db
      .prepare(
        `SELECT ${ISSUE_COLUMNS} FROM issues WHERE id = COALESCE(
           (SELECT issue_id FROM issue_fingerprints WHERE project_id = ?1 AND fingerprint = ?2),
           (SELECT id FROM issues WHERE project_id = ?1 AND fingerprint = ?2))`,
      )
      .bind(project.id, fingerprint)
      .first<IssueRow>()
  let issue = await find() // merged issues' fingerprints point at the issue they went into
  // An issue made by a try whose batch then failed has no events yet: the retry's event is still its first
  let isNew = issue?.count === 0
  if (!issue) {
    issue = await db
      .prepare(
        `INSERT INTO issues (project_id, fingerprint, title, culprit, type, level, platform, substatus, first_seen, last_seen, first_release, priority)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)
         ON CONFLICT (project_id, fingerprint) DO NOTHING RETURNING ${ISSUE_COLUMNS}`,
      )
      .bind(
        project.id,
        fingerprint,
        event.title,
        event.culprit,
        event.type,
        event.level,
        event.platform,
        event.received,
        event.received,
        event.release ?? null,
        priorityFor(project.priorities, event.level),
      )
      .first<IssueRow>()
    isNew = !!issue
    issue ??= await find() // another request made it first
    if (!issue) throw new Error('the issue could not be made')
  }

  const now = event.received
  // Ignored until N users: only a user the issue hasn't had yet counts towards it
  const newUser =
    !isNew && issue.status === 'ignored' && issue.ignore_until_users !== null && !!event.userHash
      ? !(await db
          .prepare('SELECT 1 FROM issue_users WHERE issue_id = ? AND user_hash = ?')
          .bind(issue.id, event.userHash)
          .first())
      : false
  const transition = isNew
    ? undefined
    : transitionOf(issue, event.release, now, newUser, await olderThan(db, project.id, issue, event.release, now))
  const minute = Math.floor(now / 60_000)
  const minuteCount = issue.minute === minute ? issue.minute_count + 1 : 1
  const keep = minuteCount <= SPIKE_LIMIT
  const status = transition ? 'unresolved' : issue.status
  // 'new' stays: an issue reads as new for its first week (NEW_FOR in src/search/query.ts), as Sentry's
  const substatus = transition ?? (isNew ? 'new' : issue.substatus)
  const day = dayOf(now)
  const tags = Object.entries(event.tags).slice(0, 30)

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE issues SET count = count + 1, last_seen = MAX(last_seen, ?), last_release = COALESCE(?, last_release),
           first_release = COALESCE(first_release, ?), last_event_id = ?, minute = ?, minute_count = ?, status = ?, substatus = ?,
           resolved_in_release = CASE WHEN ? THEN NULL ELSE resolved_in_release END,
           fixed_in_release = CASE WHEN ? THEN NULL ELSE fixed_in_release END,
           resolved_in_commit = CASE WHEN ? THEN NULL ELSE resolved_in_commit END,
           ignore_until_count = CASE WHEN ? THEN NULL ELSE ignore_until_count END,
           ignore_until = CASE WHEN ? THEN NULL ELSE ignore_until END,
           ignore_until_users = CASE WHEN ? THEN NULL ELSE ignore_until_users END
         WHERE id = ?`,
      )
      .bind(
        now,
        event.release ?? null,
        event.release ?? null,
        keep ? event.id : null,
        minute,
        minuteCount,
        status,
        substatus,
        transition ? 1 : 0,
        transition ? 1 : 0,
        transition ? 1 : 0,
        transition ? 1 : 0,
        transition ? 1 : 0,
        transition ? 1 : 0,
        issue.id,
      ),
    db
      .prepare(
        'INSERT INTO issue_days (issue_id, day, count) VALUES (?, ?, 1) ON CONFLICT DO UPDATE SET count = count + 1',
      )
      .bind(issue.id, day),
    db
      .prepare(
        'INSERT INTO project_days (project_id, day, events) VALUES (?, ?, 1) ON CONFLICT DO UPDATE SET events = events + 1',
      )
      .bind(project.id, day),
    // Every event, kept or only counted: metric alerts and escalation read these
    db
      .prepare(
        `INSERT INTO event_hours (project_id, issue_id, hour, level, release, environment, count) VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT DO UPDATE SET count = count + 1`,
      )
      .bind(project.id, issue.id, now - (now % 3_600_000), event.level, event.release ?? '', event.environment ?? ''),
    // Every event too, per minute: frequency routes' windows read these
    db
      .prepare(
        'INSERT INTO issue_minutes (issue_id, minute, count) VALUES (?, ?, 1) ON CONFLICT DO UPDATE SET count = count + 1',
      )
      .bind(issue.id, minute),
  ]
  if (keep) {
    statements.push(
      db
        .prepare(
          `INSERT INTO events (id, project_id, issue_id, timestamp, received, level, platform, release, environment, message, data, envelope_key, trace_id, user_hash, user_keys, fingerprint, grouping_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          event.id,
          project.id,
          issue.id,
          event.timestamp,
          now,
          event.level,
          event.platform,
          event.release ?? null,
          event.environment ?? null,
          `${event.title}\n${event.message}`.trim(),
          eventJson(event), // within its size budget: the full envelope stays in R2
          envelopeKey ?? null,
          event.traceId ?? null,
          event.userHash ?? null,
          event.userKeys ?? null,
          fingerprint,
          groupingVersion,
        ),
    )
    for (const [key, value] of tags) {
      statements.push(
        db
          .prepare('INSERT INTO event_tags (event_id, project_id, key, value) VALUES (?, ?, ?, ?)')
          .bind(event.id, project.id, key, value),
      )
    }
  }
  // A key keeps 100 values per issue; a new value past them counts under `other`. Reads stop at the value or the 100th
  for (const [key, value] of tags) {
    statements.push(
      db
        .prepare(
          `INSERT INTO issue_tag_values (issue_id, key, value, count, last_seen)
           VALUES (?1, ?2, CASE WHEN EXISTS (SELECT 1 FROM issue_tag_values WHERE issue_id = ?1 AND key = ?2 AND value = ?3)
             OR (SELECT COUNT(*) FROM (SELECT 1 FROM issue_tag_values WHERE issue_id = ?1 AND key = ?2 LIMIT ?5)) < ?5
             THEN ?3 ELSE '${OTHER_TAG_VALUE}' END, 1, ?4)
           ON CONFLICT DO UPDATE SET count = count + 1, last_seen = excluded.last_seen`,
        )
        .bind(issue.id, key, value, now, TAG_VALUES),
    )
  }
  if (event.userHash) {
    statements.push(
      db
        .prepare('INSERT OR IGNORE INTO issue_users (issue_id, user_hash) VALUES (?, ?)')
        .bind(issue.id, event.userHash),
      db
        .prepare('UPDATE issues SET user_count = (SELECT COUNT(*) FROM issue_users WHERE issue_id = ?) WHERE id = ?')
        .bind(issue.id, issue.id),
    )
  }
  if (isNew || transition) {
    const data = JSON.stringify({ eventId: event.id, release: event.release ?? null })
    statements.push(
      db
        .prepare('INSERT INTO issue_activity (issue_id, kind, data, at) VALUES (?, ?, ?, ?)')
        .bind(issue.id, isNew ? 'created' : transition!, data, now),
    )
  }
  await db.batch(statements)

  return {
    issue: { id: issue.id, title: issue.title, culprit: issue.culprit, level: event.level, count: issue.count + 1 },
    isNew,
    transition,
    countBefore: issue.count,
    stored: keep,
  }
}
