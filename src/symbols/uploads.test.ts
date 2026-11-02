import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { memoryR2, sqliteD1 } from '../../test/fakes'
import { ask, type Build, BUILD_RETRIES, chunkKey, chunksSize, MAX_PROGUARD_CACHE, storeBigDebugFile } from './uploads'

// The Workers runtime's FixedLengthStream, as a plain pass-through
class FixedLengthStream extends TransformStream {
  constructor(_length: number) {
    super()
  }
}

const sha1 = (bytes: Uint8Array) => createHash('sha1').update(bytes).digest('hex')

async function setup(file: Uint8Array) {
  const env = { DB: sqliteD1(), FILES: memoryR2() }
  env.DB.sqlite.exec(
    "INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'caliu', 'Caliu', 'k', 0)",
  )
  // Three chunks, the last shorter, as sentry-cli cuts them
  const cut = [file.subarray(0, 4), file.subarray(4, 8), file.subarray(8)]
  const chunks = await Promise.all(
    cut.map(async (c) => {
      await env.FILES.put(chunkKey(sha1(c)), c)
      return sha1(c)
    }),
  )
  return { env, chunks, checksum: sha1(file) }
}

const OBJECTS = [
  {
    debugId: 'ABCDEF01-0000-0000-0000-000000000001',
    codeId: 'c1',
    arch: 'arm64',
    fileFormat: 'macho',
    hasDebugInfo: true,
    hasSymbols: true,
  },
  {
    debugId: 'ABCDEF01-0000-0000-0000-000000000002',
    codeId: 'c2',
    arch: 'x86_64',
    fileFormat: 'macho',
    hasDebugInfo: false,
    hasSymbols: false,
  },
]

// The container, faked: it reads what it's sent, as the real one does, and answers by path
function builder(file: Uint8Array) {
  const asked: string[] = []
  const build: Build = async (path, body, size) => {
    asked.push(path)
    const got = new Uint8Array(await new Response(body).arrayBuffer())
    expect(got).toEqual(file)
    expect(size).toBe(file.length)
    if (path === '/objects') return Response.json(OBJECTS)
    if (path === '/proguardcache') {
      const cache = new TextEncoder().encode('proguardcache')
      return new Response(cache, { headers: { 'x-length': String(cache.length) } })
    }
    const cache = new TextEncoder().encode(`symcache of ${new URL(path, 'http://x').searchParams.get('id')}`)
    return new Response(cache, { headers: { 'x-length': String(cache.length) } })
  }
  return { build, asked }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('debug files too big for the worker', () => {
  it('joins the chunks in R2 and stores what the builder made, without holding the file', async () => {
    vi.stubGlobal('FixedLengthStream', FixedLengthStream)
    const file = new TextEncoder().encode('a dSYM, in three chunks')
    const { env, chunks, checksum } = await setup(file)
    expect(await chunksSize(env.FILES, chunks)).toBe(file.length)
    const { build, asked } = builder(file)
    const rows = await storeBigDebugFile(env, build, 1, checksum, 'Caliu', undefined, chunks, file.length, 5)

    expect(asked).toEqual(['/objects', '/symcache?id=ABCDEF01-0000-0000-0000-000000000001'])
    expect(rows).toMatchObject([
      { debug_id: 'abcdef01-0000-0000-0000-000000000001', arch: 'arm64', kind: 'macho', size: file.length },
    ])
    expect(env.FILES.objects.get(`debug-files/1/${checksum}`)!.body).toEqual(file)
    const cache = env.FILES.objects.get(`symcaches/1/abcdef01-0000-0000-0000-000000000001/${checksum}`)!.body
    expect(new TextDecoder().decode(cache)).toBe('symcache of ABCDEF01-0000-0000-0000-000000000001')
  })

  it('refuses chunks that don’t add up, keeping nothing', async () => {
    const file = new TextEncoder().encode('a dSYM, in three chunks')
    const { env, chunks } = await setup(file)
    const wrong = '0'.repeat(40)
    await expect(
      storeBigDebugFile(env, builder(file).build, 1, wrong, 'x', undefined, chunks, file.length, 5),
    ).rejects.toThrow('don’t add up')
    expect(env.FILES.objects.has(`debug-files/1/${wrong}`)).toBe(false)
  })

  it('stores a big ProGuard mapping with the ProguardCache the builder made', async () => {
    vi.stubGlobal('FixedLengthStream', FixedLengthStream)
    const file = new TextEncoder().encode('com.example.Player -> a.a:\n    void play() -> a\n')
    const { env, chunks, checksum } = await setup(file)
    const uuid = '4ca1e3ac-b295-3795-bab3-bc52869ebc57'
    const { build, asked } = builder(file)
    const rows = await storeBigDebugFile(
      env,
      build,
      1,
      checksum,
      `/proguard/${uuid}.txt`,
      undefined,
      chunks,
      file.length,
      5,
    )

    expect(asked).toEqual(['/proguardcache'])
    expect(rows).toMatchObject([
      { debug_id: uuid, kind: 'proguard', symcache_key: `symcaches/1/${uuid}/${checksum}`, size: file.length },
    ])
    const cache = env.FILES.objects.get(`symcaches/1/${uuid}/${checksum}`)!.body
    expect(new TextDecoder().decode(cache)).toBe('proguardcache')
  })

  it('refuses a mapping whose ProguardCache a lookup couldn’t hold, and deletes it', async () => {
    const file = new TextEncoder().encode('com.example.Player -> a.a:\n    void play() -> a\n')
    const { env, chunks, checksum } = await setup(file)
    const build: Build = async () => new Response('x', { headers: { 'x-length': String(MAX_PROGUARD_CACHE + 1) } })
    await expect(
      storeBigDebugFile(env, build, 1, checksum, 'mapping.txt', 'aa-bb', chunks, file.length, 5),
    ).rejects.toThrow('too big to read crash reports with')
    expect(env.FILES.objects.has(`debug-files/1/${checksum}`)).toBe(false)
  })

  it('says what the builder refused', async () => {
    const file = new TextEncoder().encode('not a debug file at all')
    const { env, chunks, checksum } = await setup(file)
    const build: Build = async () => Response.json({ error: 'unknown file format' }, { status: 422 })
    await expect(storeBigDebugFile(env, build, 1, checksum, 'x', undefined, chunks, file.length, 5)).rejects.toThrow(
      'unknown file format',
    )
  })
})

describe('asking the builder', () => {
  const NO_INSTANCE = 'there is no container instance that can be provided to this Durable Object, try again later'
  const body = () => new Blob(['a dSYM']).stream()

  async function settled<T>(promise: Promise<T>) {
    const result = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    await vi.runAllTimersAsync()
    return result
  }

  it('tries again while Cloudflare has no container instance, with the file sent whole each time', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const got: string[] = []
    let tries = 0
    const build: Build = async (_path, stream) => {
      got.push(await new Response(stream).text())
      if (++tries === 1) throw new Error(NO_INSTANCE)
      if (tries === 2) return Response.json({ error: 'busy' }, { status: 503 })
      return Response.json([])
    }
    const { value } = (await settled(ask(build, '/objects', body, 6))) as { value: Response }
    expect(await value.json()).toEqual([])
    expect(got).toEqual(['a dSYM', 'a dSYM', 'a dSYM'])
  })

  it('gives up once its tries are spent, with what went wrong', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let tries = 0
    const build: Build = async () => {
      tries++
      throw new Error(NO_INSTANCE)
    }
    const { error } = (await settled(ask(build, '/objects', body, 6))) as { error: Error }
    expect(error.message).toBe(NO_INSTANCE)
    expect(tries).toBe(BUILD_RETRIES.length + 1)
  })

  it('doesn’t try again when the builder refused the file', async () => {
    let tries = 0
    const build: Build = async () => {
      tries++
      return Response.json({ error: 'unknown file format' }, { status: 422 })
    }
    await expect(ask(build, '/objects', body, 6)).rejects.toThrow('unknown file format')
    expect(tries).toBe(1)
  })
})
