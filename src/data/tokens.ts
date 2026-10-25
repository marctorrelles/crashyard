// Auth tokens for sentry-cli and the build plugins (SENTRY_AUTH_TOKEN): shown once when made, kept as a SHA-256.
// They work for every project, and only for uploads and releases.

export type TokenRow = { id: number; name: string; created_by: string; created_at: number; last_used_at: number | null }

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

export async function createToken(db: D1Database, name: string, by: string, now: number) {
  const token = `cyt_${[...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('')}`
  await db
    .prepare('INSERT INTO tokens (name, hash, scopes, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(name, await sha256(token), 'project:releases project:write', by, now)
    .run()
  return token
}

export const listTokens = async (db: D1Database) =>
  (
    await db
      .prepare('SELECT id, name, created_by, created_at, last_used_at FROM tokens ORDER BY created_at DESC')
      .all<TokenRow>()
  ).results

export const revokeToken = (db: D1Database, id: number) => db.prepare('DELETE FROM tokens WHERE id = ?').bind(id).run()

/** The token a request carries (`Authorization: Bearer …`), if it's one of ours; marks it used */
export async function tokenOf(db: D1Database, request: Request, now: number) {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]
  if (!bearer) return null
  const row = await db
    .prepare('SELECT id, name FROM tokens WHERE hash = ?')
    .bind(await sha256(bearer))
    .first<{ id: number; name: string }>()
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
