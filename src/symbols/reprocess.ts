// When a debug file or source map arrives after the events that needed it: their frames are mapped again, and their
// issues regrouped, since a stack that was addresses now groups by functions. An issue takes the fingerprint its
// newest event now has; if another issue already has it, the two merge.
import { mergeIssues } from '../data/issues'
import type { NormalizedEvent } from '../ingest/event'
import { groupingFor, type Project } from '../ingest/store'
import type { Symbolic } from './symcache'
import { type SymbolEnv, symbolicate } from './symbolicate'

const DAYS = 30
const LIMIT = 500

export async function reprocess(
  env: SymbolEnv,
  symbolic: () => Promise<Symbolic>,
  projectId: number,
  debugIds: string[],
  now = Date.now(),
) {
  if (!debugIds.length) return
  // Debug ids are stored as the SDK sent them, which may be upper case; LIKE is case-insensitive for ASCII. The ids go
  // as one JSON value: a bundle has hundreds, and D1 binds 100 values at most
  const events = (
    await env.DB.prepare(
      `SELECT id, issue_id, data FROM events WHERE project_id = ? AND received >= ?
         AND EXISTS (SELECT 1 FROM json_each(?) j WHERE events.data LIKE '%' || j.value || '%')
       ORDER BY received DESC LIMIT ${LIMIT}`,
    )
      .bind(projectId, now - DAYS * 864e5, JSON.stringify(debugIds))
      .all<{ id: string; issue_id: number; data: string }>()
  ).results
  if (!events.length) return
  const project = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).first<Project>()
  if (!project) return
  const newestPerIssue = new Map<number, { event: NormalizedEvent; fingerprint: string }>()
  for (const row of events) {
    const event = JSON.parse(row.data) as NormalizedEvent
    await symbolicate(env, symbolic, projectId, event)
    // Grouped as ingest groups: the project's rules, then its grouping version
    const { fingerprint, version } = await groupingFor(env.DB, project, event, now)
    await env.DB.prepare('UPDATE events SET data = ?, fingerprint = ?, grouping_version = ? WHERE id = ?')
      .bind(JSON.stringify(event), fingerprint, version, row.id)
      .run()
    if (!newestPerIssue.has(row.issue_id)) newestPerIssue.set(row.issue_id, { event, fingerprint })
  }
  for (const [issueId, { event, fingerprint }] of newestPerIssue) {
    const issue = await env.DB.prepare('SELECT fingerprint FROM issues WHERE id = ?')
      .bind(issueId)
      .first<{ fingerprint: string }>()
    if (!issue || issue.fingerprint === fingerprint) continue
    const other = await env.DB.prepare(
      `SELECT id FROM issues WHERE id = COALESCE(
         (SELECT issue_id FROM issue_fingerprints WHERE project_id = ?1 AND fingerprint = ?2),
         (SELECT id FROM issues WHERE project_id = ?1 AND fingerprint = ?2))`,
    )
      .bind(projectId, fingerprint)
      .first<{ id: number }>()
    if (other && other.id !== issueId) {
      await mergeIssues(env.DB, [other.id, issueId], 'crashyard (readable stacks)', now)
    } else if (!other) {
      await env.DB.batch([
        env.DB.prepare(
          'INSERT OR REPLACE INTO issue_fingerprints (project_id, fingerprint, issue_id, regrouped) VALUES (?, ?, ?, 1)',
        ).bind(projectId, issue.fingerprint, issueId),
        env.DB.prepare('UPDATE issues SET fingerprint = ?, title = ?, culprit = ? WHERE id = ?').bind(
          fingerprint,
          event.title,
          event.culprit,
          issueId,
        ),
      ])
    }
  }
}
