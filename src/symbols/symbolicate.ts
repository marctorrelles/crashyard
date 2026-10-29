// Readable stacks: before an event is grouped, its frames are mapped back to the source with what was uploaded.
// - Native (Apple, NDK): each address, relative to its image, through that image's SymCache; inlined calls come
//   back as frames of their own. Frames below the crashing one point at return addresses, so they're looked up
//   one byte earlier, as Sentry does.
// - Android: classes, methods and lines through the ProGuard mapping the event names (debug_meta, type proguard).
// - JavaScript: positions through the source map found by the file's debug id, or else its URL.
// What it can't map stays as it came, and the debug files it lacked are listed on the event.
import { culpritOf, type Frame, type NormalizedEvent } from '../ingest/event'
import type { Loaded, Symbolic, SymbolFrame } from './symcache'

export type SymbolEnv = { DB: D1Database; FILES: R2Bucket }

// What lookups read, kept in the isolate: SourceMapCaches and which file a debug id names
// (for ten minutes, so an upload is seen by every isolate soon after)
// ponytail: one byte budget for all, first in first out; an LRU if hit rates matter
const BUDGET = 48 * 1024 * 1024
const TTL = 10 * 60_000
const cache = new Map<string, { value: unknown; size: number; at: number }>()
let cached = 0
async function remember<T>(key: string, size: (v: T) => number, load: () => Promise<T | null>): Promise<T | null> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.value as T
  if (hit) {
    cache.delete(key)
    cached -= hit.size
  }
  const value = await load()
  if (value === null) return null
  const n = size(value)
  while (cached + n > BUDGET && cache.size) {
    const [oldest, entry] = cache.entries().next().value!
    cache.delete(oldest)
    cached -= entry.size
  }
  cache.set(key, { value, size: n, at: Date.now() })
  cached += n
  return value
}

// SymCaches and ProguardCaches are kept in the module's own memory instead, read there straight from R2, so a big one
// (40 MB for a 107 MB dSYM, 48 MB for a 112 MB mapping) is never held twice. Its key names its file's checksum, so it never goes stale. A lookup pins what it
// uses until it's done: a load for another event, between its awaits, can't free it under it
// ponytail: first in first out within 64 MB, one alone may be bigger; an LRU if hit rates matter
const KEPT_BUDGET = 64 * 1024 * 1024
type Kept = Loaded & { pins: number }
const kept = new WeakMap<
  Symbolic,
  { loaded: Map<string, Kept>; loading: Map<string, Promise<Kept | null>>; size: number }
>()
async function pinSymcache(s: Symbolic, files: R2Bucket, key: string): Promise<Kept | null> {
  let k = kept.get(s)
  if (!k) kept.set(s, (k = { loaded: new Map(), loading: new Map(), size: 0 }))
  const store = k
  const hit = store.loaded.get(key)
  if (hit) return (hit.pins++, hit)
  let pending = store.loading.get(key)
  if (!pending) {
    pending = (async () => {
      const object = await files.get(key)
      if (!object) return null
      for (const [old, entry] of store.loaded) {
        if (store.size + object.size <= KEPT_BUDGET) break
        if (entry.pins) continue
        store.loaded.delete(old)
        store.size -= entry.len
        s.free(entry)
      }
      const entry: Kept = { ...(await s.load(object.size, object.body)), pins: 0 }
      store.loaded.set(key, entry)
      store.size += entry.len
      return entry
    })().finally(() => store.loading.delete(key))
    store.loading.set(key, pending)
  }
  const entry = await pending
  if (entry) entry.pins++
  return entry
}

const r2Bytes = async (files: R2Bucket, key: string) => {
  const object = await files.get(key)
  return object ? new Uint8Array(await object.arrayBuffer()) : null
}

const NATIVE = new Set(['macho', 'elf', 'pe', 'wasm', 'symbolic', 'apple'])
const hex = (v?: string) => {
  if (!v) return undefined
  try {
    return BigInt(v)
  } catch {
    return undefined
  }
}

type DebugRow = { debug_id: string; kind: string; file_key: string; symcache_key: string | null }

export async function symbolicate(
  env: SymbolEnv,
  symbolic: () => Promise<Symbolic>,
  projectId: number,
  event: NormalizedEvent,
) {
  // Every stack: the exceptions', then each thread's, through the same caches
  const targets: { frames: Frame[]; set: (frames: Frame[]) => void }[] = [
    ...event.exceptions.map((e) => ({ frames: e.frames, set: (f: Frame[]) => void (e.frames = f) })),
    ...(event.threads ?? []).map((t) => ({ frames: t.frames, set: (f: Frame[]) => void (t.frames = f) })),
  ].filter((t) => t.frames.length)
  const stacks = targets.map((t) => t.frames)
  if (!stacks.length) return
  const images = event.debugImages.filter((i) => i.debugId)
  const ids = [...new Set(images.map((i) => i.debugId!.toLowerCase()))]
  const rows = ids.length
    ? (
        await env.DB.prepare(
          `SELECT debug_id, kind, file_key, symcache_key FROM debug_files WHERE project_id = ? AND debug_id IN (SELECT value FROM json_each(?))
           ORDER BY created_at DESC`,
        )
          .bind(projectId, JSON.stringify(ids))
          .all<DebugRow>()
      ).results
    : []
  const fileOf = new Map<string, DebugRow>()
  for (const row of rows) if (!fileOf.has(row.debug_id)) fileOf.set(row.debug_id, row)
  const missing = new Map<string, NonNullable<NormalizedEvent['missingDebugFiles']>[number]>()

  // Native
  const native = images
    .filter((i) => NATIVE.has(i.type) && hex(i.imageAddr) !== undefined)
    .map((i) => ({
      ...i,
      start: hex(i.imageAddr)!,
      end: i.imageSize ? hex(i.imageAddr)! + BigInt(i.imageSize) : undefined,
    }))
  if (native.length) {
    const s = await symbolic()
    // Each frame's image and address first, then one lookup per image with all of them: a SymCache goes into Wasm
    // once an event, not once a frame
    const byImage = new Map<string, { symcache: Kept | null; addresses: bigint[]; found: SymbolFrame[][] }>()
    const asks: ({ image: string; at: number } | undefined)[][] = []
    try {
      for (const frames of stacks) {
        const asked: (typeof asks)[number] = []
        asks.push(asked)
        for (const [index, frame] of frames.entries()) {
          const addr = hex(frame.instructionAddr)
          const image =
            addr === undefined
              ? undefined
              : native.find((i) =>
                  frame.imageAddr
                    ? hex(frame.imageAddr) === i.start
                    : addr >= i.start && (i.end === undefined || addr < i.end),
                )
          if (!image || addr === undefined || frame.symbolicated) {
            asked.push(undefined)
            continue
          }
          const debugId = image.debugId!.toLowerCase()
          let lookup = byImage.get(debugId)
          if (!lookup) {
            const row = fileOf.get(debugId)
            const symcache = row?.symcache_key ? await pinSymcache(s, env.FILES, row.symcache_key) : null
            lookup = { symcache, addresses: [], found: [] }
            byImage.set(debugId, lookup)
          }
          if (!lookup.symcache) {
            if ((!frame.function || frame.function === '<redacted>') && !isSystemImage(image.codeFile))
              missing.set(debugId, { debugId, codeFile: image.codeFile, type: image.type })
            asked.push(undefined)
            continue
          }
          // The crashing frame (the last) points at the instruction; the rest at return addresses
          const relative = addr - image.start - (index === frames.length - 1 ? 0n : 1n)
          asked.push({ image: debugId, at: lookup.addresses.push(relative) - 1 })
        }
      }
      for (const lookup of byImage.values())
        if (lookup.symcache && lookup.addresses.length) lookup.found = s.lookup(lookup.symcache, lookup.addresses)
    } finally {
      for (const lookup of byImage.values()) if (lookup.symcache) lookup.symcache.pins--
    }
    for (const [n, frames] of stacks.entries()) {
      stacks[n] = frames.flatMap((frame, i) => {
        const ask = asks[n][i]
        const found = ask && byImage.get(ask.image)!.found[ask.at]
        if (!found?.length) return [frame]
        // Innermost first from symbolic; frames here run oldest first
        return [...found].reverse().map((f) => ({
          ...frame,
          function: f.function,
          filename: f.file && f.file !== '<compiler-generated>' ? f.file.split('/').at(-1) : frame.filename,
          absPath: f.file ?? frame.absPath,
          lineno: f.line || undefined,
          context: undefined,
          symbolicated: true,
        }))
      })
    }
  }

  // Android
  const proguard = images.filter((i) => i.type === 'proguard').map((i) => i.debugId!.toLowerCase())
  for (const debugId of new Set(proguard)) {
    const key = fileOf.get(debugId)?.symcache_key
    if (!key) {
      missing.set(debugId, { debugId, type: 'proguard' })
      continue
    }
    const s = await symbolic()
    const cache = await pinSymcache(s, env.FILES, key)
    if (!cache) continue
    // Every stack's frames and every exception's class in one call: the mapper is built once a mapping, not once a
    // stack, which for a large mapping and an ANR's every thread was most of the work
    const java = stacks.map((frames) =>
      frames.map((f) => ({
        module: f.symbolicated ? '' : (f.module ?? ''),
        function: f.function ?? '',
        lineno: f.lineno,
      })),
    )
    const classes = event.exceptions.map((e) => (e.module ? `${e.module}.${e.type}` : e.type))
    let all: ReturnType<Symbolic['proguard']>
    try {
      all = s.proguard(cache, [...java.flat(), ...classes.map((module) => ({ module, function: '' }))])
    } finally {
      cache.pins--
    }
    let at = 0
    for (const [n, frames] of stacks.entries()) {
      const remapped = all.slice(at, (at += frames.length))
      if (!java[n].some((f) => f.module)) continue
      stacks[n] = frames.flatMap((frame, i) =>
        remapped[i]?.length
          ? [...remapped[i]].reverse().map((r) => ({
              ...frame,
              module: r.module,
              function: r.function,
              lineno: r.lineno || frame.lineno,
              filename: r.file ?? frame.filename,
              symbolicated: true,
            }))
          : [frame],
      )
    }
    // An app's own exception classes are obfuscated too
    for (const [i, e] of event.exceptions.entries()) {
      const full = classes[i]
      const original = all[at + i]?.[0]?.module
      if (original && original !== full) {
        const dot = original.lastIndexOf('.')
        e.module = dot > 0 ? original.slice(0, dot) : undefined
        e.type = original.slice(dot + 1)
        if (e === event.exceptions.at(-1) && !e.synthetic) event.title = e.value ? `${e.type}: ${e.value}` : e.type
      }
    }
  }

  // JavaScript, for projects with artifact bundles
  if (!(await hasBundles(env.DB, projectId))) return finish(event, targets, stacks, missing)
  const sourceMaps = new Map(
    images.filter((i) => i.type === 'sourcemap' && i.codeFile).map((i) => [i.codeFile!, i.debugId!.toLowerCase()]),
  )
  for (const frames of stacks) {
    for (const frame of frames) {
      const at = frame.absPath ?? frame.filename
      if (!at || frame.symbolicated || frame.lineno === undefined || frame.colno === undefined) continue
      const cacheBytes = await sourceMapCacheFor(env, projectId, sourceMaps.get(at), at)
      if (!cacheBytes) continue
      const [found] = (await symbolic()).sourcemapLookup(cacheBytes, [[frame.lineno - 1, frame.colno - 1]])
      if (!found?.file) continue
      Object.assign(frame, {
        filename: found.file.replace(/^(webpack:\/\/\/?|\.\.?\/)+/, ''),
        lineno: found.line + 1,
        colno: found.column + 1,
        function: found.function ?? frame.function,
        inApp: !/node_modules/.test(found.file),
        context: found.context !== null ? { pre: found.pre, line: found.context, post: found.post } : frame.context,
        symbolicated: true,
      })
    }
  }

  finish(event, targets, stacks, missing)
}

const bundlesSeen = new Map<number, { has: boolean; at: number }>()

/** The OS's own libraries (Apple's, Android's): no one has their debug files to upload, so they're never missing */
const isSystemImage = (codeFile?: string) =>
  !!codeFile && /^(\/usr\/lib\/|\/System\/|\/Developer\/|\/system\/|\/apex\/|\/vendor\/|dyld$)/.test(codeFile)

/** After an upload: what this isolate remembered missing for the project is looked up again (others, within minutes) */
export function forgetMissing(projectId: number) {
  bundlesSeen.delete(projectId)
  for (const [key, entry] of cache) {
    if (key.startsWith(`smrow:${projectId}:`) && entry.value === false) {
      cache.delete(key)
      cached -= entry.size
    }
  }
}
async function hasBundles(db: D1Database, projectId: number) {
  const hit = bundlesSeen.get(projectId)
  if (hit && Date.now() - hit.at < 60_000) return hit.has
  const has = !!(await db
    .prepare('SELECT 1 FROM artifact_bundles WHERE project_id = ? LIMIT 1')
    .bind(projectId)
    .first())
  bundlesSeen.set(projectId, { has, at: Date.now() })
  return has
}

function finish(
  event: NormalizedEvent,
  targets: { set: (frames: Frame[]) => void }[],
  stacks: Frame[][],
  missing: Map<string, NonNullable<NormalizedEvent['missingDebugFiles']>[number]>,
) {
  stacks.forEach((frames, n) => targets[n].set(frames))
  const thrown = event.exceptions.at(-1)
  if (thrown?.frames.some((f) => f.symbolicated)) event.culprit = culpritOf(thrown.frames) ?? event.culprit
  event.missingDebugFiles = missing.size ? [...missing.values()] : undefined
}

/** The SourceMapCache for a minified file: by the debug id the event gives it, or else by its URL (~/path) */
async function sourceMapCacheFor(env: SymbolEnv, projectId: number, debugId: string | undefined, url: string) {
  let tilde: string
  try {
    tilde = `~${new URL(url).pathname}`
  } catch {
    tilde = url.startsWith('~') ? url : `~/${url.replace(/^\/+/, '')}`
  }
  const row = await remember<{ cache_key: string } | false>(
    `smrow:${projectId}:${debugId ?? tilde}`,
    () => 64,
    async () =>
      (await env.DB.prepare(
        `SELECT f.cache_key FROM artifact_files f JOIN artifact_bundles b ON b.id = f.bundle_id
         WHERE f.project_id = ? AND f.type = 'minified_source' AND f.cache_key IS NOT NULL AND (f.debug_id = ? OR f.url = ?)
         ORDER BY f.debug_id = ? DESC, b.created_at DESC LIMIT 1`,
      )
        .bind(projectId, debugId ?? '', tilde, debugId ?? '')
        .first<{ cache_key: string }>()) ?? false,
  )
  if (!row) return null
  return remember<Uint8Array>(
    `smc:${row.cache_key}`,
    (b) => b.length,
    () => r2Bytes(env.FILES, row.cache_key),
  )
}
