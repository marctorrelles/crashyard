// Auth tokens for sentry-cli and the build plugins (SENTRY_AUTH_TOKEN): shown once when made, kept as a SHA-256.
// Each works for one project or every project, and only for uploads and releases.

export type TokenRow = {
  id: number
  name: string
  project_id: number | null // null: every project
  project: string | null // its slug
  created_by: string
  created_at: number
  last_used_at: number | null
}

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

/** A new token, for one project or every project (`projectId` null) */
export async function createToken(
  db: D1Database,
  name: string,
  by: string,
  now: number,
  projectId: number | null = null,
) {
  const token = `cyt_${[...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('')}`
  await db
    .prepare('INSERT INTO tokens (name, hash, scopes, project_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(name, await sha256(token), 'project:releases project:write', projectId, by, now)
    .run()
  return token
}

export const listTokens = async (db: D1Database) =>
  (
    await db
      .prepare(
        `SELECT t.id, t.name, t.project_id, p.slug AS project, t.created_by, t.created_at, t.last_used_at FROM tokens t
         LEFT JOIN projects p ON p.id = t.project_id ORDER BY t.created_at DESC`,
      )
      .all<TokenRow>()
  ).results

export const revokeToken = (db: D1Database, id: number) => db.prepare('DELETE FROM tokens WHERE id = ?').bind(id).run()

/** The token a request carries (`Authorization: Bearer …`), if it's one of ours; marks it used */
export async function tokenOf(db: D1Database, request: Request, now: number) {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]
  if (!bearer) return null
  const row = await db
    .prepare('SELECT id, name, project_id FROM tokens WHERE hash = ?')
    .bind(await sha256(bearer))
    .first<{ id: number; name: string; project_id: number | null }>()
  if (row) await db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').bind(now, row.id).run()
  return row
}

/** What a project has uploaded: debug files and artifact bundles, newest first */
export async function uploadsOf(db: D1Database, projectId: number) {
  const [files, bundles] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        'SELECT debug_id, kind, arch, name, size, created_at FROM debug_files WHERE project_id = ? ORDER BY created_at DESC LIMIT 20',
      )
      .bind(projectId),
    db
      .prepare(
        `SELECT b.checksum, b.release, b.size, b.created_at, COUNT(f.path) AS files FROM artifact_bundles b
         LEFT JOIN artifact_files f ON f.bundle_id = b.id WHERE b.project_id = ? GROUP BY b.id ORDER BY b.created_at DESC LIMIT 10`,
      )
      .bind(projectId),
  ])
  return {
    debugFiles: files.results as {
      debug_id: string
      kind: string
      arch: string | null
      name: string
      size: number
      created_at: number
    }[],
    bundles: bundles.results as {
      checksum: string
      release: string | null
      size: number
      created_at: number
      files: number
    }[],
  }
}

export type DebugFile = {
  id: number
  debug_id: string
  kind: string
  arch: string | null
  name: string
  size: number
  created_at: number
}

/** Settings, Debug files: the newest 500, all searched in the page */
export const debugFilesOf = async (db: D1Database, projectId: number) =>
  (
    await db
      .prepare(
        'SELECT id, debug_id, kind, arch, name, size, created_at FROM debug_files WHERE project_id = ? ORDER BY created_at DESC LIMIT 500',
      )
      .bind(projectId)
      .all<DebugFile>()
  ).results

/**
 * A debug file's row and its R2 objects, the file and its symcache, unless another row still uses them (the archs of
 * one fat binary share the file). Stacks already symbolicated keep their names
 */
export async function deleteDebugFile(db: D1Database, files: R2Bucket, projectId: number, id: number) {
  const row = await db
    .prepare('SELECT file_key, symcache_key FROM debug_files WHERE id = ? AND project_id = ?')
    .bind(id, projectId)
    .first<{ file_key: string; symcache_key: string | null }>()
  if (!row) return
  await db.prepare('DELETE FROM debug_files WHERE id = ?').bind(id).run()
  const keys = [row.file_key, row.symcache_key].filter((k): k is string => !!k)
  const used = await db
    .prepare(
      `SELECT file_key AS k FROM debug_files WHERE file_key IN (${keys.map(() => '?').join(',')})
       UNION SELECT symcache_key FROM debug_files WHERE symcache_key IN (${keys.map(() => '?').join(',')})`,
    )
    .bind(...keys, ...keys)
    .all<{ k: string }>()
  const still = new Set(used.results.map((r) => r.k))
  const gone = keys.filter((k) => !still.has(k))
  if (gone.length) await files.delete(gone)
}
