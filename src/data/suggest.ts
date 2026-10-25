// The search bar's suggestions from what's stored: keys and their values, by how often they're seen. Every query is
// bounded: keys LIMIT 50, values LIMIT 20; logs read only the newest 5000 in the range.
const KEYS = 50
const VALUES = 20
const LOG_SAMPLE = 5000

// A prefix for LIKE: its own % _ \ escaped (with ESCAPE '\'), then anything after
const like = (prefix: string) => `${prefix.replace(/[\\%_]/g, '\\$&')}%`

// Keys whose values the bar knows without asking (enums, numbers, times, `has:` from the keys) or has none to offer
const ISSUE_LOCAL = new Set([
  'is',
  'level',
  'has',
  'times',
  'events',
  'users',
  'lastSeen',
  'firstSeen',
  'trace',
  'issue.id',
])
const ISSUE_COLUMNS: Record<string, string> = {
  type: 'type',
  platform: 'platform',
  firstRelease: 'first_release',
  lastRelease: 'last_release',
}
const LOG_LOCAL = new Set(['level', 'has', 'timestamp', 'trace', 'message', 'body'])
const LOG_COLUMNS: Record<string, string> = { release: 'release', environment: 'environment' }

type Count = { key: string; count: number }
type ValueCount = { value: string; count: number }

/** Tag keys on issues, by how many issues have them */
export async function issueKeys(db: D1Database, projectId?: number): Promise<Count[]> {
  const join = projectId === undefined ? '' : 'JOIN issues i ON i.id = v.issue_id AND i.project_id = ?'
  return (
    await db
      .prepare(
        `SELECT v.key, COUNT(DISTINCT v.issue_id) AS count FROM issue_tag_values v ${join}
         GROUP BY v.key ORDER BY count DESC LIMIT ${KEYS}`,
      )
      .bind(...(projectId === undefined ? [] : [projectId]))
      .all<Count>()
  ).results
}

/** A key's values on issues starting with `prefix` (case-insensitive), by events */
export async function issueValues(
  db: D1Database,
  key: string,
  prefix: string,
  projectId?: number,
): Promise<ValueCount[]> {
  if (ISSUE_LOCAL.has(key)) return []
  const project = projectId === undefined ? [] : [projectId]
  if (key === 'project') {
    return (
      await db
        .prepare(
          `SELECT p.slug AS value, COUNT(i.id) AS count FROM projects p LEFT JOIN issues i ON i.project_id = p.id
           WHERE p.slug LIKE ? ESCAPE '\\' GROUP BY p.id ORDER BY count DESC LIMIT ${VALUES}`,
        )
        .bind(like(prefix))
        .all<ValueCount>()
    ).results
  }
  const column = ISSUE_COLUMNS[key]
  if (column) {
    return (
      await db
        .prepare(
          `SELECT ${column} AS value, COUNT(*) AS count FROM issues
           WHERE ${column} LIKE ? ESCAPE '\\' ${projectId === undefined ? '' : 'AND project_id = ?'}
           GROUP BY ${column} ORDER BY count DESC LIMIT ${VALUES}`,
        )
        .bind(like(prefix), ...project)
        .all<ValueCount>()
    ).results
  }
  const join = projectId === undefined ? '' : 'JOIN issues i ON i.id = v.issue_id AND i.project_id = ?'
  return (
    await db
      .prepare(
        `SELECT v.value, SUM(v.count) AS count FROM issue_tag_values v ${join}
         WHERE v.key = ? AND v.value LIKE ? ESCAPE '\\' GROUP BY v.value ORDER BY count DESC LIMIT ${VALUES}`,
      )
      .bind(...project, key, like(prefix))
      .all<ValueCount>()
  ).results
}

// The newest logs in the range (of a project): what the log suggestions count over
const sample = (projectId: number | undefined) =>
  `SELECT id FROM logs WHERE timestamp >= ? ${projectId === undefined ? '' : 'AND project_id = ?'}
   ORDER BY timestamp DESC LIMIT ${LOG_SAMPLE}`
const sampleParams = (projectId: number | undefined, since: number) =>
  projectId === undefined ? [since] : [since, projectId]

/** The app's attribute keys on logs since `since`, by how many of the newest 5000 have them */
export async function logKeys(db: D1Database, projectId: number | undefined, since: number): Promise<Count[]> {
  return (
    await db
      .prepare(
        `SELECT key, COUNT(*) AS count FROM log_attributes WHERE log_id IN (${sample(projectId)})
         GROUP BY key ORDER BY count DESC LIMIT ${KEYS}`,
      )
      .bind(...sampleParams(projectId, since))
      .all<Count>()
  ).results
}

/** A key's values on the newest 5000 logs since `since`, starting with `prefix` (case-insensitive) */
export async function logValues(
  db: D1Database,
  key: string,
  prefix: string,
  projectId: number | undefined,
  since: number,
): Promise<ValueCount[]> {
  if (LOG_LOCAL.has(key)) return []
  const params = sampleParams(projectId, since)
  if (key === 'project') {
    return (
      await db
        .prepare(
          `SELECT p.slug AS value, COUNT(*) AS count FROM logs l JOIN projects p ON p.id = l.project_id
           WHERE l.id IN (${sample(projectId)}) AND p.slug LIKE ? ESCAPE '\\'
           GROUP BY p.id ORDER BY count DESC LIMIT ${VALUES}`,
        )
        .bind(...params, like(prefix))
        .all<ValueCount>()
    ).results
  }
  const column = LOG_COLUMNS[key]
  if (column) {
    return (
      await db
        .prepare(
          `SELECT ${column} AS value, COUNT(*) AS count FROM logs WHERE id IN (${sample(projectId)})
           AND ${column} LIKE ? ESCAPE '\\' GROUP BY ${column} ORDER BY count DESC LIMIT ${VALUES}`,
        )
        .bind(...params, like(prefix))
        .all<ValueCount>()
    ).results
  }
  return (
    await db
      .prepare(
        `SELECT value, COUNT(*) AS count FROM log_attributes WHERE log_id IN (${sample(projectId)})
         AND key = ? AND value LIKE ? ESCAPE '\\' GROUP BY value ORDER BY count DESC LIMIT ${VALUES}`,
      )
      .bind(...params, key, like(prefix))
      .all<ValueCount>()
  ).results
}
