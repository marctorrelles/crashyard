// The settings pages' numbers: what each day took in and turned away (Usage), and how the deployment is doing (Health).
import { PLAN_KEY, type Plan } from './plan'
import { CRON_KEY, getSetting } from './settings'
import { lastDays } from './projects'

/** Per UTC day, oldest first, over `days` days to today: what was let in and what wasn't, of one project or all */
export async function usage(db: D1Database, projectId: number | undefined, days: number, now: number) {
  const list = lastDays(days, now)
  const { results } = await db
    .prepare(
      `SELECT day, SUM(events) AS events, SUM(logs) AS logs, SUM(transactions) AS transactions, SUM(dropped) AS dropped,
         SUM(filtered) AS filtered, SUM(failed) AS failed
       FROM project_days WHERE day >= ?${projectId === undefined ? '' : ' AND project_id = ?'} GROUP BY day`,
    )
    .bind(list[0], ...(projectId === undefined ? [] : [projectId]))
    .all<Record<'events' | 'logs' | 'transactions' | 'dropped' | 'filtered' | 'failed', number> & { day: string }>()
  const byDay = new Map(results.map((r) => [r.day, r]))
  const series = (k: 'events' | 'logs' | 'transactions' | 'dropped' | 'filtered' | 'failed') =>
    list.map((d) => byDay.get(d)?.[k] ?? 0)
  return {
    days: list,
    events: series('events'),
    logs: series('logs'),
    transactions: series('transactions'),
    dropped: series('dropped'), // envelopes turned away whole by a daily limit
    filtered: series('filtered'),
    failed: series('failed'), // envelopes that failed every retry
  }
}

/** D1's own cap on one database, on Workers Paid and on Free */
const D1_LIMIT = 10_000_000_000
const D1_FREE_LIMIT = 500_000_000
/** Past this, the R2 counts read "1,000 or more" */
const LIST_CAP = 1000
/** Past this, the pruning backlog reads "10,000 or more" */
export const BACKLOG_CAP = 10_000

async function countKeys(files: R2Bucket, prefix: string) {
  const page = await files.list({ prefix, limit: LIST_CAP })
  return { count: page.objects.length, more: page.truncated }
}

/** How the deployment is doing: the database's size, stored files, the cron, notifications, envelopes, pruning */
export async function health(env: { DB: D1Database; FILES: R2Bucket }, now: number) {
  const db = env.DB
  // Any query reports the database's size after it; this one reads nothing
  const size = (await db.prepare('SELECT 1').run()).meta as { size_after?: number }
  const [files, failures, backlog] = await db.batch<Record<string, unknown>>([
    db.prepare(
      `SELECT (SELECT COALESCE(SUM(size), 0) FROM debug_files) AS debug_files,
         (SELECT COALESCE(SUM(size), 0) FROM artifact_bundles) AS bundles,
         (SELECT COALESCE(SUM(size), 0) FROM attachments) AS attachments`,
    ),
    db
      .prepare(
        `SELECT f.id, f.kind, f.error, f.at, c.name AS channel FROM notification_failures f
         LEFT JOIN channels c ON c.id = f.channel_id WHERE f.at >= ? ORDER BY f.at DESC LIMIT 20`,
      )
      .bind(now - 7 * 864e5),
    // Counted up to the cap, each by the prune's own join
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM events e JOIN projects p ON p.id = e.project_id
           WHERE e.received < ?1 - p.event_retention_days * 86400000 LIMIT ?2)) AS events,
         (SELECT COUNT(*) FROM (SELECT 1 FROM logs l JOIN projects p ON p.id = l.project_id
           WHERE l.timestamp < ?1 - p.log_retention_days * 86400000 LIMIT ?2)) AS logs`,
      )
      .bind(now, BACKLOG_CAP),
  ])
  const [failureCount, pending, failed, lastRun, plan] = await Promise.all([
    db
      .prepare('SELECT COUNT(*) AS n FROM notification_failures WHERE at >= ?')
      .bind(now - 7 * 864e5)
      .first<{ n: number }>(),
    countKeys(env.FILES, 'pending/'),
    countKeys(env.FILES, 'failed/'),
    getSetting<number | null>(db, CRON_KEY, null),
    getSetting<Plan | null>(db, PLAN_KEY, null),
  ])
  const f = files.results[0] as { debug_files: number; bundles: number; attachments: number }
  return {
    database: { bytes: size.size_after ?? null, limit: plan?.paid === false ? D1_FREE_LIMIT : D1_LIMIT },
    files: { debugFiles: f.debug_files, bundles: f.bundles, attachments: f.attachments },
    cron: { lastRun, late: lastRun === null || now - lastRun > 3 * 60_000 },
    notifications: {
      failed: failureCount?.n ?? 0,
      recent: failures.results as { id: number; kind: string; error: string; at: number; channel: string | null }[],
    },
    envelopes: { pending, failed },
    backlog: backlog.results[0] as { events: number; logs: number },
  }
}
