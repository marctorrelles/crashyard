// Writing an event: its issue (made, counted, reopened), the event itself, its tags and the counts, in one D1 batch.
import type { NormalizedEvent } from './event'

export type Project = {
  id: number
  slug: string
  name: string
  public_key: string
  daily_event_quota: number
  daily_log_quota: number
  daily_transaction_quota: number
}

type IssueRow = {
  id: number
  status: string
  substatus: string | null
  resolved_in_release: string | null
  ignore_until_count: number | null
  ignore_until: number | null
  count: number
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
export function transitionOf(issue: IssueRow, release: string | undefined, now: number): Stored['transition'] {
  if (issue.status === 'resolved') {
    // Resolved now: any new event is a regression. Resolved in the next release: an event from another release is; an
    // event that names no release can't say, so it isn't.
    if (issue.resolved_in_release === null) return 'regressed'
    if (release && release !== issue.resolved_in_release) return 'regressed'
  }
  if (issue.status === 'ignored') {
    if (issue.ignore_until_count !== null && issue.count + 1 >= issue.ignore_until_count) return 'ignore_expired'
    if (issue.ignore_until !== null && now >= issue.ignore_until) return 'ignore_expired'
  }
  return undefined
}

const ISSUE_COLUMNS =
  'id, status, substatus, resolved_in_release, ignore_until_count, ignore_until, count, minute, minute_count, title, culprit, level'

export async function storeEvent(
  db: D1Database,
  project: Project,
  event: NormalizedEvent,
  fingerprint: string,
  envelopeKey?: string,
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
        `INSERT INTO issues (project_id, fingerprint, title, culprit, type, level, platform, substatus, first_seen, last_seen, first_release)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
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
      )
      .first<IssueRow>()
    isNew = !!issue
    issue ??= await find() // another request made it first
    if (!issue) throw new Error('the issue could not be made')
  }

  const now = event.received
  const transition = isNew ? undefined : transitionOf(issue, event.release, now)
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
           ignore_until_count = CASE WHEN ? THEN NULL ELSE ignore_until_count END,
           ignore_until = CASE WHEN ? THEN NULL ELSE ignore_until END
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
  ]
  if (keep) {
    statements.push(
      db
        .prepare(
          `INSERT INTO events (id, project_id, issue_id, timestamp, received, level, platform, release, environment, message, data, envelope_key, trace_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          JSON.stringify(event),
          envelopeKey ?? null,
          event.traceId ?? null,
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
