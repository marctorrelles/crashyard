// The part of Sentry's API (/api/0/…) that sentry-cli and the build plugins (Xcode's build phase, the Gradle plugin,
// @sentry/vite-plugin) call: chunked uploads, assembling debug files and artifact bundles, and releases. Answers
// in Sentry's shapes, checked against sentry-cli 3.8 (test/uploads.e2e.test.ts). The organisation in the path is
// ignored: a deployment is one organisation. Every call needs an auth token (Authorization: Bearer), and a token of one
// project is refused for any other.
import { previousWithCommits, storeCommits, type GitCommit } from '../data/source'
import { tokenOf } from '../data/tokens'
import { forgetMissing } from '../symbols/symbolicate'
import type { Symbolic } from '../symbols/symcache'
import {
  CHUNK_SIZE,
  chunkKey,
  joinChunks,
  MAX_FILE,
  missingChunks,
  sha1,
  storeBundle,
  storeDebugFile,
  type DebugFileRow,
} from '../symbols/uploads'

export type SentryApiEnv = { DB: D1Database; FILES: R2Bucket }
type Ctx = {
  env: SentryApiEnv
  ctx: ExecutionContext
  symbolic: () => Promise<Symbolic>
  reprocess: (projectId: number, debugIds: string[]) => Promise<void>
}

const json = (body: unknown, status = 200) => Response.json(body, { status })
const detail = (message: string, status: number) => json({ detail: message }, status)
// Sentry's answer to a token without access to the project
const forbidden = () => detail('You do not have permission to perform this action.', 403)

type Assemble = Record<string, { name?: string; debug_id?: string; chunks?: string[] }>

const projectId = async (db: D1Database, slug: string) =>
  (await db.prepare('SELECT id FROM projects WHERE slug = ?').bind(slug).first<{ id: number }>())?.id

const difOf = (row: DebugFileRow) => ({
  id: String(row.id),
  uuid: row.debug_id,
  debugId: row.debug_id,
  codeId: row.code_id,
  cpuName: row.arch ?? 'any',
  objectName: row.name,
  symbolType: row.kind,
  headers: {},
  size: row.size,
  sha1: row.checksum,
  dateCreated: new Date(row.created_at).toISOString(),
  data: { features: row.kind === 'proguard' ? ['mapping'] : ['debug', 'symtab', 'unwind'] },
})

export async function handleSentryApi(request: Request, { env, ctx, symbolic, reprocess }: Ctx): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/?$/, '/')
  const now = Date.now()
  const token = await tokenOf(env.DB, request, now)
  if (!token) return detail('Invalid token', 401)
  // A token of one project reaches only that project
  const allowed = (id: number) => token.project_id === null || token.project_id === id

  if (path === '/api/0/')
    return json({ version: '0', auth: { scopes: ['project:releases', 'project:write'] }, user: null })

  let m = path.match(/^\/api\/0\/organizations\/([^/]+)\/chunk-upload\/$/)
  if (m && request.method === 'GET') {
    return json({
      url: `${url.origin}/api/0/organizations/${m[1]}/chunk-upload/`,
      chunkSize: CHUNK_SIZE,
      chunksPerRequest: 8,
      maxFileSize: MAX_FILE,
      maxRequestSize: 64 * 1024 * 1024,
      concurrency: 4,
      hashAlgorithm: 'sha1',
      compression: ['gzip'],
      accept: [
        'debug_files',
        'release_files',
        'pdbs',
        'sources',
        'bcsymbolmaps',
        'portablepdbs',
        'artifact_bundles',
        'proguard',
      ],
    })
  }
  if (m && request.method === 'POST') {
    const form = await request.formData()
    const parts = [
      ...form.getAll('file').map((f) => [f, false] as const),
      ...form.getAll('file_gzip').map((f) => [f, true] as const),
    ]
    for (const [part, gzipped] of parts) {
      if (typeof part === 'string') continue
      let bytes = new Uint8Array(await part.arrayBuffer())
      if (gzipped)
        bytes = new Uint8Array(
          await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(),
        )
      const sum = await sha1(bytes)
      if (part.name && part.name !== sum) return detail(`chunk ${part.name} doesn’t match its checksum`, 400)
      await env.FILES.put(chunkKey(sum), bytes)
    }
    return json({})
  }

  m = path.match(/^\/api\/0\/projects\/([^/]+)\/([^/]+)\/files\/difs\/assemble\/$/)
  if (m && request.method === 'POST') {
    const id = await projectId(env.DB, m[2])
    if (!id) return detail(`No project ${m[2]}`, 404)
    if (!allowed(id)) return forbidden()
    const body = (await request.json()) as Assemble
    const out: Record<string, unknown> = {}
    const fresh: string[] = []
    for (const [checksum, file] of Object.entries(body)) {
      const chunks = file.chunks ?? []
      const existing = await env.DB.prepare('SELECT * FROM debug_files WHERE project_id = ? AND checksum = ? LIMIT 1')
        .bind(id, checksum)
        .first<DebugFileRow>()
      if (existing) {
        out[checksum] = { state: 'ok', missingChunks: [], dif: difOf(existing) }
        continue
      }
      const missing = await missingChunks(env.FILES, chunks)
      if (missing.length || !chunks.length) {
        out[checksum] = { state: 'not_found', missingChunks: missing }
        continue
      }
      try {
        const bytes = await joinChunks(env.FILES, chunks, checksum)
        const rows = await storeDebugFile(env, symbolic, id, checksum, file.name ?? checksum, file.debug_id, bytes, now)
        ctx.waitUntil(env.FILES.delete(chunks.map(chunkKey)))
        fresh.push(...rows.map((r) => r.debug_id))
        out[checksum] = { state: 'ok', missingChunks: [], dif: difOf(rows[0]) }
      } catch (error) {
        out[checksum] = {
          state: 'error',
          missingChunks: [],
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    }
    if (fresh.length) ctx.waitUntil(reprocess(id, fresh))
    return json(out)
  }

  m = path.match(/^\/api\/0\/organizations\/([^/]+)\/artifactbundle\/assemble\/$/)
  if (m && request.method === 'POST') {
    const body = (await request.json()) as {
      checksum: string
      chunks?: string[]
      projects?: string[]
      version?: string
      dist?: string
    }
    const ids = (await Promise.all((body.projects ?? []).map((slug) => projectId(env.DB, slug)))).filter(
      (x): x is number => !!x,
    )
    if (!ids.length) return detail('No such project', 404)
    if (!ids.every(allowed)) return forbidden()
    const chunks = body.chunks ?? []
    const done = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM artifact_bundles WHERE checksum = ? AND project_id IN (${ids.map(() => '?').join(',')})`,
    )
      .bind(body.checksum, ...ids)
      .first<{ n: number }>()
    if (done?.n === ids.length) return json({ state: 'ok', missingChunks: [] })
    const missing = await missingChunks(env.FILES, chunks)
    if (missing.length || !chunks.length) return json({ state: 'not_found', missingChunks: missing })
    try {
      const bytes = await joinChunks(env.FILES, chunks, body.checksum)
      const debugIds = await storeBundle(env, symbolic, ids, body.checksum, body.version, body.dist, bytes, now)
      for (const id of ids) forgetMissing(id)
      ctx.waitUntil(env.FILES.delete(chunks.map(chunkKey)))
      if (debugIds.length) for (const id of ids) ctx.waitUntil(reprocess(id, debugIds))
      return json({ state: 'ok', missingChunks: [] })
    } catch (error) {
      return json({ state: 'error', missingChunks: [], detail: error instanceof Error ? error.message : String(error) })
    }
  }

  // No repositories are linked: sentry-cli's `releases set-commits` then reads the commits from the local git
  m = path.match(/^\/api\/0\/organizations\/([^/]+)\/repos\/$/)
  if (m) return json([])

  // The release before with commits, so set-commits sends only the commits since its head (404: none, the first)
  m = path.match(/^\/api\/0\/organizations\/([^/]+)\/releases\/([^/]+)\/previous-with-commits\/$/)
  if (m) {
    const previous = await previousWithCommits(env.DB, decodeURIComponent(m[2]))
    return previous
      ? json({
          version: previous.version,
          dateCreated: new Date(previous.created_at).toISOString(),
          projects: [],
          lastCommit: { id: previous.ref },
        })
      : detail('No release before with commits', 404)
  }

  // Releases: kept per project, with their commits, so a release names where it came from
  m = path.match(/^\/api\/0\/organizations\/([^/]+)\/releases\/(?:([^/]+)\/(deploys\/)?)?$/)
  if (m) {
    const version = m[2] ? decodeURIComponent(m[2]) : undefined
    const body = (request.method === 'GET' ? {} : await request.json().catch(() => ({}))) as {
      version?: string
      projects?: string[]
      ref?: string
      dateReleased?: string
      commits?: GitCommit[]
    }
    const name = version ?? body.version
    if (!name) return detail('A release needs a version', 400)
    const slugs = body.projects ?? []
    const release = {
      version: name,
      ref: body.ref ?? null,
      dateCreated: new Date(now).toISOString(),
      dateReleased: body.dateReleased ?? null,
      projects: slugs.map((slug) => ({ slug, name: slug })),
    }
    if (m[3]) return json({ id: '1', environment: 'production', dateFinished: new Date(now).toISOString() }, 201)
    if (request.method === 'GET') return json(release)
    const ids = await Promise.all(slugs.map((slug) => projectId(env.DB, slug)))
    if (!ids.every((id) => !id || allowed(id))) return forbidden()
    for (const id of ids) {
      if (!id) continue
      await env.DB.prepare(
        `INSERT INTO releases (project_id, version, ref, created_at, released_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET ref = COALESCE(excluded.ref, ref), released_at = COALESCE(excluded.released_at, released_at)`,
      )
        .bind(id, name, body.ref ?? null, now, body.dateReleased ? Date.parse(body.dateReleased) : null)
        .run()
    }
    // set-commits names no project: the commits go to every project with this release, or only the token's
    if (body.commits?.length) await storeCommits(env.DB, name, body.commits, token.project_id)
    return json(release, request.method === 'POST' ? 201 : 200)
  }

  return detail('Not found', 404)
}
