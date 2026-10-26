// Stacks linked to the code: a release's commits and the repository's files, from sentry-cli's
// `releases set-commits --local`, and each frame of an event matched to a file and its line in the repository.
import type { Frame, NormalizedEvent } from '../ingest/event'

/** A commit as sentry-cli sends it from the local git (3.8): newest first, with the files it changed */
export type GitCommit = {
  id: string
  message?: string
  author_name?: string
  timestamp?: string
  patch_set?: { path: string; type: string }[] // type A, M or D
}

/** The commits go to every project with this release (only `only`'s, for a project's token); its head becomes the
 * release's ref */
export async function storeCommits(db: D1Database, version: string, commits: GitCommit[], only: number | null = null) {
  const projects = (
    await db.prepare('SELECT project_id FROM releases WHERE version = ?').bind(version).all<{ project_id: number }>()
  ).results
    .map((r) => r.project_id)
    .filter((id) => only === null || id === only)
  // Oldest first, so the last change to a path wins
  const present = new Map<string, boolean>()
  for (const c of [...commits].reverse()) for (const f of c.patch_set ?? []) present.set(f.path, f.type !== 'D')
  const added = [...present].filter(([, on]) => on).map(([path]) => path)
  const deleted = [...present].filter(([, on]) => !on).map(([path]) => path)
  const statements = projects.flatMap((project) => [
    db.prepare('DELETE FROM release_commits WHERE project_id = ? AND version = ?').bind(project, version),
    ...commits.map((c, position) =>
      db
        .prepare(
          'INSERT INTO release_commits (project_id, version, position, sha, message, author, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          project,
          version,
          position,
          c.id,
          (c.message ?? '').trim(),
          c.author_name ?? null,
          c.timestamp ? Date.parse(c.timestamp) || null : null,
        ),
    ),
    db
      .prepare('UPDATE releases SET ref = ? WHERE project_id = ? AND version = ?')
      .bind(commits[0].id, project, version),
    db
      .prepare('INSERT OR IGNORE INTO source_files (project_id, path) SELECT ?, value FROM json_each(?)')
      .bind(project, JSON.stringify(added)),
    db
      .prepare('DELETE FROM source_files WHERE project_id = ? AND path IN (SELECT value FROM json_each(?))')
      .bind(project, JSON.stringify(deleted)),
  ])
  if (statements.length) await db.batch(statements)
}

/** The newest release before this one, of the same projects, that has commits */
export const previousWithCommits = (db: D1Database, version: string) =>
  db
    .prepare(
      `SELECT r.version, r.created_at, r.ref FROM releases r
       WHERE r.version != ?1 AND r.ref IS NOT NULL
         AND r.project_id IN (SELECT project_id FROM releases WHERE version = ?1)
         AND r.created_at <= (SELECT MIN(created_at) FROM releases WHERE version = ?1)
         AND EXISTS (SELECT 1 FROM release_commits c WHERE c.project_id = r.project_id AND c.version = r.version)
       ORDER BY r.created_at DESC LIMIT 1`,
    )
    .bind(version)
    .first<{ version: string; created_at: number; ref: string }>()

export type Commit = { sha: string; message: string; author: string | null; at: number | null; url: string | null }

/** A release's commits since the release before, newest first, each linked when the project has a repository */
export async function releaseCommits(
  db: D1Database,
  project: { id: number; repo_url: string | null },
  version: string,
) {
  const rows = (
    await db
      .prepare(
        'SELECT sha, message, author, at FROM release_commits WHERE project_id = ? AND version = ? ORDER BY position',
      )
      .bind(project.id, version)
      .all<Omit<Commit, 'url'>>()
  ).results
  return rows.map((c) => ({ ...c, url: project.repo_url ? commitUrl(project.repo_url, c.sha) : null }))
}

/** Each in-app frame of the event that matches one file of the repository, as `exception.frame` (indexes) → its URL */
export async function frameLinks(
  db: D1Database,
  project: { id: number; repo_url: string | null },
  event: NormalizedEvent,
): Promise<Record<string, string>> {
  if (!project.repo_url) return {}
  const [files, release] = await db.batch<{ path?: string; ref?: string }>([
    db.prepare('SELECT path FROM source_files WHERE project_id = ?').bind(project.id),
    db.prepare('SELECT ref FROM releases WHERE project_id = ? AND version = ?').bind(project.id, event.release ?? ''),
  ])
  if (!files.results.length) return {}
  // Without the release's commit, the default branch: its lines may have moved since
  return linksOf(
    event,
    indexFiles(files.results.map((f) => f.path!)),
    project.repo_url,
    release.results[0]?.ref ?? 'HEAD',
  )
}

export function linksOf(event: NormalizedEvent, files: FileIndex, repo: string, ref: string) {
  const links: Record<string, string> = {}
  event.exceptions.forEach((e, i) =>
    e.frames.forEach((f, j) => {
      const path = f.inApp ? matchFile(files, f) : null
      if (path) links[`${i}.${j}`] = codeUrl(repo, ref, path, f.lineno)
    }),
  )
  return links
}

const segments = (p: string) =>
  p
    .replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '') // webpack://_N_E, app://
    .split(/[\\/]+/)
    .filter((s) => s && s !== '.' && s !== '~')

export type FileIndex = Map<string, string[][]> // a file's name → the paths with it, as segments

export function indexFiles(paths: string[]): FileIndex {
  const index: FileIndex = new Map()
  for (const p of paths) {
    const s = p.split('/')
    const list = index.get(s.at(-1)!) ?? []
    list.push(s)
    index.set(s.at(-1)!, list)
  }
  return index
}

/**
 * The repository's file a frame is in: the one whose path ends with the most of the frame's (its absolute path, its
 * file, or for Java and Kotlin its package's folders and file). None when two match as well
 */
export function matchFile(files: FileIndex, f: Pick<Frame, 'absPath' | 'filename' | 'module'>): string | null {
  const candidates = [f.absPath, f.filename]
  if (f.module?.includes('.') && f.filename && !/[\\/]/.test(f.filename))
    candidates.push(`${f.module.split('.').slice(0, -1).join('/')}/${f.filename}`)
  let best: string[] | null = null
  let bestScore = 0
  let tie = false
  for (const c of candidates) {
    if (!c) continue
    const s = segments(c)
    for (const file of files.get(s.at(-1) ?? '') ?? []) {
      let score = 0
      while (score < file.length && score < s.length && file.at(-1 - score) === s.at(-1 - score)) score++
      if (score > bestScore) [best, bestScore, tie] = [file, score, false]
      else if (score === bestScore && file !== best) tie = true
    }
  }
  return best && !tie ? best.join('/') : null
}

const gitlab = (repo: string) => /gitlab/i.test(new URL(repo).hostname)
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

/** A file's line on GitHub (or GitLab, by its host) */
export const codeUrl = (repo: string, ref: string, path: string, line?: number) =>
  `${repo}${gitlab(repo) ? '/-' : ''}/blob/${ref}/${encodePath(path)}${line ? `#L${line}` : ''}`

export const commitUrl = (repo: string, sha: string) => `${repo}${gitlab(repo) ? '/-' : ''}/commit/${sha}`

/** A repository's web address from what's typed: https only, without `.git` or a trailing slash */
export function repoUrl(text: string): string | null {
  const t = text
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  if (!t) return null
  const url = URL.canParse(t) ? new URL(t) : null
  if (url?.protocol !== 'https:' || url.pathname.split('/').filter(Boolean).length < 2)
    throw new Error('Enter the repository’s https address, for example https://github.com/owner/repo.')
  return `${url.origin}${url.pathname}`
}
