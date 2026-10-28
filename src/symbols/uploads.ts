// Sentry's chunked uploads: sentry-cli and the build plugins send a file as chunks named by their SHA-1, then ask
// to assemble them. A debug file becomes one row per object (architecture) with its SymCache; a ProGuard mapping is
// kept as it is; an artifact bundle (a zip of minified files and source maps) is indexed by its files' debug ids.
import { createHash } from 'node:crypto'
import { unzipSync, strFromU8 } from 'fflate'
import type { Symbolic } from './symcache'

export const CHUNK_SIZE = 8 * 1024 * 1024
// What a 128 MB isolate can assemble and convert itself: the file, then its copy in the Wasm module that makes the
// SymCache, which grows to about three times the file (a 16 MB dSYM took 44 MB, a 107 MB one 328 MB)
export const MAX_FILE = 48 * 1024 * 1024
// With the SymCache builder (builder.ts), debug files past WORKER_FILE go to it, up to BIG_FILE: its container has 4 GB
export const WORKER_FILE = 16 * 1024 * 1024
export const BIG_FILE = 512 * 1024 * 1024
/** Asks the builder's container: a path and the file as the body */
export type Build = (path: string, body: ReadableStream, size: number) => Promise<Response>

export const chunkKey = (sha1: string) => `chunks/${sha1}`

export async function sha1(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest('SHA-1', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Which of these chunks aren't in R2 yet */
export async function missingChunks(files: R2Bucket, chunks: string[]) {
  const heads = await Promise.all(chunks.map((c) => files.head(chunkKey(c))))
  return chunks.filter((_, i) => !heads[i])
}

/** The chunks, joined, and checked against the file's SHA-1 */
export async function joinChunks(
  files: R2Bucket,
  chunks: string[],
  checksum: string,
): Promise<Uint8Array<ArrayBuffer>> {
  // Sizes first, then each chunk read into its place: the file is held once, not beside a copy of every chunk
  const objects = await Promise.all(
    chunks.map(async (c) => {
      const object = await files.head(chunkKey(c))
      if (!object) throw new Error(`chunk ${c} is gone`)
      return object
    }),
  )
  const size = objects.reduce((n, o) => n + o.size, 0)
  if (size > MAX_FILE)
    throw new Error(
      `This file is over ${MAX_FILE / 1024 / 1024} MB, the most crashyard can process here. Debug files can be bigger with the SymCache builder (docs/deploying.md).`,
    )
  const file = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    const object = await files.get(chunkKey(c))
    if (!object) throw new Error(`chunk ${c} is gone`)
    const part = new Uint8Array(await object.arrayBuffer())
    if (at + part.length > size) throw new Error('the chunks don’t add up to the checksum')
    file.set(part, at)
    at += part.length
  }
  if ((await sha1(file)) !== checksum) throw new Error('the chunks don’t add up to the checksum')
  return file
}

/** The size of the file the chunks make, from their heads */
export async function chunksSize(files: R2Bucket, chunks: string[]) {
  const heads = await Promise.all(chunks.map((c) => files.head(chunkKey(c))))
  return heads.reduce((n, h, i) => {
    if (!h) throw new Error(`chunk ${chunks[i]} is gone`)
    return n + h.size
  }, 0)
}

/** The chunks joined straight into R2 as a multipart upload, never whole in memory, and checked against the file's
 *  SHA-1; a file that doesn't add up is aborted. sentry-cli's chunks are all CHUNK_SIZE but the last, as R2's parts
 *  must be */
export async function assembleInto(files: R2Bucket, chunks: string[], checksum: string, key: string) {
  const hash = createHash('sha1')
  const upload = await files.createMultipartUpload(key)
  try {
    const parts: R2UploadedPart[] = []
    for (const [i, c] of chunks.entries()) {
      const object = await files.get(chunkKey(c))
      if (!object) throw new Error(`chunk ${c} is gone`)
      const part = new Uint8Array(await object.arrayBuffer())
      hash.update(part)
      parts.push(await upload.uploadPart(i + 1, part))
    }
    if (hash.digest('hex') !== checksum) throw new Error('the chunks don’t add up to the checksum')
    await upload.complete(parts)
  } catch (error) {
    await upload.abort().catch(() => {})
    throw error
  }
}

// A ProGuard (R8) mapping: lines of `original.Class -> obfuscated:`, with comments
const isProguard = (file: Uint8Array) =>
  /^(?:#[^\n]*\n)*[\w.$]+ -> [\w.$]+:\s*$/m.test(strFromU8(file.subarray(0, 4096)).split('\n').slice(0, 40).join('\n'))

export type DebugFileRow = {
  id: number
  debug_id: string
  code_id: string | null
  arch: string | null
  kind: string
  name: string
  checksum: string
  size: number
  created_at: number
}

/** Stores an assembled debug file: one row per object, its SymCache beside it. Returns the rows */
export async function storeDebugFile(
  env: { DB: D1Database; FILES: R2Bucket },
  symbolic: () => Promise<Symbolic>,
  projectId: number,
  checksum: string,
  name: string,
  claimedDebugId: string | undefined,
  file: Uint8Array,
  now: number,
): Promise<DebugFileRow[]> {
  const fileKey = `debug-files/${projectId}/${checksum}`
  const rows: Omit<DebugFileRow, 'id'>[] = []
  const caches: [string, Uint8Array][] = []
  if (isProguard(file)) {
    const debugId = claimedDebugId?.toLowerCase() ?? name.match(/[0-9a-f-]{36}/i)?.[0].toLowerCase()
    if (!debugId) throw new Error('a ProGuard mapping needs its UUID (sentry-cli upload-proguard sets it)')
    rows.push({
      debug_id: debugId,
      code_id: null,
      arch: null,
      kind: 'proguard',
      name,
      checksum,
      size: file.length,
      created_at: now,
    })
  } else {
    // One instance per file: its memory grows to a few times the file, and is dropped with it
    const s = await symbolic()
    for (const object of s.objects(file)) {
      if (!object.hasDebugInfo && !object.hasSymbols) continue
      const debugId = object.debugId.toLowerCase()
      caches.push([`symcaches/${projectId}/${debugId}/${checksum}`, s.symcache(file, object.debugId)])
      rows.push({
        debug_id: debugId,
        code_id: object.codeId,
        arch: object.arch,
        kind: object.fileFormat,
        name,
        checksum,
        size: file.length,
        created_at: now,
      })
    }
    if (!rows.length) throw new Error('nothing to symbolicate with in this file: no debug info, no symbols')
  }
  await Promise.all([env.FILES.put(fileKey, file), ...caches.map(([key, bytes]) => env.FILES.put(key, bytes))])
  return insertRows(env.DB, projectId, checksum, fileKey, rows, now)
}

/**
 * A debug file too big for the worker, its chunks joined into R2 and its SymCaches made by the builder's container,
 * each streamed from R2 to it and back: the worker never holds the file. Not for a ProGuard mapping, which lookups
 * would have to hold
 */
export async function storeBigDebugFile(
  env: { DB: D1Database; FILES: R2Bucket },
  build: Build,
  projectId: number,
  checksum: string,
  name: string,
  chunks: string[],
  size: number,
  now: number,
): Promise<DebugFileRow[]> {
  const fileKey = `debug-files/${projectId}/${checksum}`
  await assembleInto(env.FILES, chunks, checksum, fileKey)
  try {
    const head = await env.FILES.get(fileKey, { range: { offset: 0, length: 4096 } })
    if (head && isProguard(new Uint8Array(await head.arrayBuffer())))
      throw new Error(`ProGuard mappings can be up to ${MAX_FILE / 1024 / 1024} MB`)
    const ask = async (path: string) => {
      const object = await env.FILES.get(fileKey)
      if (!object) throw new Error('the assembled file is gone')
      const answer = await build(path, object.body, size)
      if (!answer.ok) {
        const why = (await answer.json().catch(() => null)) as { error?: string } | null
        throw new Error(why?.error ?? `the SymCache builder answered HTTP ${answer.status}`)
      }
      return answer
    }
    const objects = (await (await ask('/objects')).json()) as {
      debugId: string
      codeId: string | null
      arch: string
      fileFormat: string
      hasDebugInfo: boolean
      hasSymbols: boolean
    }[]
    const rows: Omit<DebugFileRow, 'id'>[] = []
    for (const object of objects.filter((o) => o.hasDebugInfo || o.hasSymbols)) {
      const debugId = object.debugId.toLowerCase()
      const answer = await ask(`/symcache?id=${encodeURIComponent(object.debugId)}`)
      const length = Number(answer.headers.get('x-length'))
      if (!length || !answer.body) throw new Error('the SymCache builder sent no SymCache')
      // Straight on to R2, at its length
      const { readable, writable } = new FixedLengthStream(length)
      const piped = answer.body.pipeTo(writable)
      await Promise.all([env.FILES.put(`symcaches/${projectId}/${debugId}/${checksum}`, readable), piped])
      rows.push({
        debug_id: debugId,
        code_id: object.codeId,
        arch: object.arch,
        kind: object.fileFormat,
        name,
        checksum,
        size,
        created_at: now,
      })
    }
    if (!rows.length) throw new Error('nothing to symbolicate with in this file: no debug info, no symbols')
    return insertRows(env.DB, projectId, checksum, fileKey, rows, now)
  } catch (error) {
    await env.FILES.delete(fileKey)
    throw error
  }
}

async function insertRows(
  db: D1Database,
  projectId: number,
  checksum: string,
  fileKey: string,
  rows: Omit<DebugFileRow, 'id'>[],
  now: number,
) {
  const stored: DebugFileRow[] = []
  for (const row of rows) {
    const symcacheKey = row.kind === 'proguard' ? null : `symcaches/${projectId}/${row.debug_id}/${checksum}`
    const r = await db
      .prepare(
        `INSERT INTO debug_files (project_id, checksum, name, debug_id, code_id, arch, kind, file_key, symcache_key, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, debug_id, checksum) DO UPDATE SET name = excluded.name RETURNING *`,
      )
      .bind(
        projectId,
        checksum,
        row.name,
        row.debug_id,
        row.code_id,
        row.arch,
        row.kind,
        fileKey,
        symcacheKey,
        row.size,
        now,
      )
      .first<DebugFileRow>()
    stored.push(r!)
  }
  return stored
}

type Manifest = {
  files?: Record<string, { url?: string; type?: string; headers?: Record<string, string> }>
  release?: string
  dist?: string
}

/** Stores an artifact bundle: a SourceMapCache for each minified file with its map, indexed by debug id and URL.
 * Returns the debug ids in it */
export async function storeBundle(
  env: { DB: D1Database; FILES: R2Bucket },
  symbolic: () => Promise<Symbolic>,
  projectIds: number[],
  checksum: string,
  release: string | undefined,
  dist: string | undefined,
  file: Uint8Array,
  now: number,
): Promise<string[]> {
  const entries = unzipSync(file)
  if (!entries['manifest.json']) throw new Error('not an artifact bundle: no manifest.json')
  const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as Manifest
  const files = Object.entries(manifest.files ?? {}).map(([path, f]) => {
    const headers = Object.fromEntries(Object.entries(f.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    return {
      path,
      url: f.url ?? null,
      type: f.type ?? 'unknown',
      debugId: headers['debug-id']?.toLowerCase(),
      sourcemap: headers.sourcemap,
    }
  })
  const maps = files.filter((f) => f.type === 'source_map')
  // A minified file's map: the one with its debug id, or the one its `sourcemap` header names (beside it)
  const pairs = files
    .filter((f) => f.type === 'minified_source')
    .map((min) => {
      const byId = min.debugId ? maps.find((m) => m.debugId === min.debugId) : undefined
      const mapUrl =
        min.sourcemap && min.url ? `~${new URL(min.sourcemap, `http://x${min.url.slice(1)}`).pathname}` : undefined
      const byUrl = mapUrl ? maps.find((m) => m.url === mapUrl) : undefined
      return { min, map: byId ?? byUrl }
    })
    .filter(
      (p): p is { min: (typeof files)[number]; map: (typeof files)[number] } =>
        !!p.map && !!entries[p.min.path] && !!entries[p.map.path],
    )
  const s = pairs.length ? await symbolic() : undefined
  const caches = pairs.map((p) => ({
    ...p,
    key: `smcaches/${checksum}/${p.min.path.replace(/[^\w.-]+/g, '_')}`,
    bytes: s!.sourcemapcache(entries[p.min.path], entries[p.map.path]),
  }))
  const fileKey = `bundles/${checksum}`
  await Promise.all([env.FILES.put(fileKey, file), ...caches.map((c) => env.FILES.put(c.key, c.bytes))])
  for (const projectId of projectIds) {
    const bundle = await env.DB.prepare(
      `INSERT INTO artifact_bundles (project_id, checksum, release, dist, file_key, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, checksum) DO UPDATE SET release = COALESCE(excluded.release, release) RETURNING id`,
    )
      .bind(
        projectId,
        checksum,
        release ?? manifest.release ?? null,
        dist ?? manifest.dist ?? null,
        fileKey,
        file.length,
        now,
      )
      .first<{ id: number }>()
    const statements = caches.map((c) =>
      env.DB.prepare(
        'INSERT OR REPLACE INTO artifact_files (bundle_id, project_id, debug_id, type, path, url, cache_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(bundle!.id, projectId, c.min.debugId ?? '', 'minified_source', c.min.path, c.min.url, c.key),
    )
    if (statements.length) await env.DB.batch(statements)
  }
  return [...new Set(caches.map((c) => c.min.debugId).filter((d): d is string => !!d))]
}
