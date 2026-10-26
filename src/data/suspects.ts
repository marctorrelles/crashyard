// Triage help on an issue's page: the commits that may have caused it, and issues that look like the same crash.
import type { NormalizedEvent } from '../ingest/event'
import { type Commit, commitUrl, indexFiles, matchFile } from './source'

/** Frames grouping reads first: the app's, nearest the crash */
const TOP_FRAMES = 5

/**
 * The commits of the issue's first release that changed a file its top in-app frames are in, newest first, each
 * with the files it changed among them. None without the release's commit files (set-commits sends them)
 */
export async function suspectCommits(
  db: D1Database,
  issue: { project_id: number; first_release: string | null },
  event: NormalizedEvent | null,
  repo: string | null,
): Promise<(Commit & { files: string[] })[]> {
  const frames = (event?.exceptions.at(-1)?.frames ?? []).filter((f) => f.inApp).slice(-TOP_FRAMES)
  if (!issue.first_release || !frames.length) return []
  const rows = (
    await db
      .prepare(
        `SELECT c.sha, c.message, c.author, c.at, c.position, f.path FROM release_commits c
         JOIN commit_files f ON f.project_id = c.project_id AND f.sha = c.sha
         WHERE c.project_id = ? AND c.version = ? AND f.kind != 'D' ORDER BY c.position`,
      )
      .bind(issue.project_id, issue.first_release)
      .all<{ sha: string; message: string; author: string | null; at: number | null; position: number; path: string }>()
  ).results
  if (!rows.length) return []
  // The frames matched against the files these commits changed, as stack links match the repository's
  const index = indexFiles([...new Set(rows.map((r) => r.path))])
  const touched = new Set(frames.map((f) => matchFile(index, f)).filter((p): p is string => !!p))
  const bySha = new Map<string, Commit & { files: string[] }>()
  for (const r of rows) {
    if (!touched.has(r.path)) continue
    const commit = bySha.get(r.sha) ?? {
      sha: r.sha,
      message: r.message,
      author: r.author,
      at: r.at,
      url: repo ? commitUrl(repo, r.sha) : null,
      files: [],
    }
    commit.files.push(r.path)
    bySha.set(r.sha, commit)
  }
  return [...bySha.values()] // in position order: newest first
}

export type SimilarIssue = {
  id: number
  title: string
  culprit: string
  count: number
  last_seen: number
  status: string
}

/**
 * Issues of the same project that look like this one under another fingerprint: the same exception type (the start
 * of the title) and the same top in-app function (the culprit is it), unresolved first, then the busiest, 10 at most
 */
export async function similarIssues(
  db: D1Database,
  issue: { id: number; project_id: number; culprit: string; type: string },
  event: NormalizedEvent | null,
): Promise<SimilarIssue[]> {
  const main = event?.exceptions.at(-1)
  if (issue.type !== 'error' || !issue.culprit || !main || main.synthetic) return []
  return (
    await db
      .prepare(
        `SELECT id, title, culprit, count, last_seen, status FROM issues
         WHERE project_id = ?1 AND id != ?2 AND type = 'error' AND culprit = ?3
           AND (title = ?4 OR substr(title, 1, length(?4) + 2) = ?4 || ': ')
         ORDER BY status = 'unresolved' DESC, count DESC LIMIT 10`,
      )
      .bind(issue.project_id, issue.id, issue.culprit, main.type)
      .all<SimilarIssue>()
  ).results
}
