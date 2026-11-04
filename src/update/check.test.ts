import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUILDER_NOTE, BUNDLE, latest, newer, pick, type Release, UNREACHABLE } from './check'

const release = (tag: string, extra: Partial<Release> = {}): Release => ({
  tag_name: tag,
  html_url: `https://github.com/r/${tag}`,
  body: null,
  draft: false,
  prerelease: false,
  assets: [{ name: BUNDLE, browser_download_url: `https://dl/${tag}`, digest: `sha256:${tag}` }],
  ...extra,
})

describe('newer', () => {
  it('compares versions part by part, as numbers', () => {
    expect(newer('v1.10.0', '1.9.2')).toBe(true)
    expect(newer('0.1.0', '0.1.0')).toBe(false)
    expect(newer('0.1.0', '0.2.0')).toBe(false)
  })
})

describe('pick', () => {
  it('takes the newest release, and a builder change in any release up to it', () => {
    const releases = [release('v0.4.0'), release('v0.3.0', { body: BUILDER_NOTE }), release('v0.2.0', { body: 'x' })]
    expect(pick(releases, '0.2.0')).toEqual({
      version: '0.4.0',
      current: '0.2.0',
      url: 'https://github.com/r/v0.4.0',
      builder: true,
      major: false,
      bundle: { url: 'https://dl/v0.4.0', digest: 'sha256:v0.4.0' },
    })
    expect(pick(releases, '0.3.0')?.builder).toBe(false)
    expect(pick(releases, '0.4.0')).toBeNull()
  })

  it('skips drafts and pre-releases, and tells a major version and a release without a build', () => {
    const releases = [release('v2.0.0', { prerelease: true }), release('v1.0.0', { assets: [] }), release('v0.9.0')]
    expect(pick(releases, '0.9.0')).toMatchObject({ version: '1.0.0', major: true, bundle: null })
  })
})

describe('latest', () => {
  afterEach(() => vi.unstubAllGlobals())
  // The Cache API as a map, and GitHub answering `status` with a release past this version
  const stub = (status: number) => {
    const kept = new Map<string, Response>()
    vi.stubGlobal('caches', {
      default: {
        match: async (url: string) => kept.get(url)?.clone(),
        put: async (url: string, response: Response) => void kept.set(url, response),
      },
    })
    const fetch = vi.fn(async () => Response.json([release('v99.0.0')], { status }))
    vi.stubGlobal('fetch', fetch)
    return { kept, fetch }
  }

  it('keeps the day’s answer with when it was asked, and Check now asks again', async () => {
    const { fetch } = stub(200)
    const first = await latest()
    expect(first.update?.version).toBe('99.0.0')
    expect(first.checkedAt).toBeTypeOf('number')
    expect(await latest()).toEqual(first)
    expect(fetch).toHaveBeenCalledTimes(1)
    // A release file, not the API with its 60 unsigned requests an hour that Workers share
    expect(fetch.mock.calls[0]).toEqual([
      expect.stringMatching(/github\.com\/[^/]+\/[^/]+\/releases\/latest\/download\/releases\.json$/),
      expect.anything(),
    ])
    await latest(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('never reads a failed ask as up to date, and Check now’s failure keeps the answer it had', async () => {
    const { kept, fetch } = stub(403)
    expect(await latest()).toEqual({ update: null, checkedAt: null })
    kept.clear()
    fetch.mockResolvedValueOnce(Response.json([release('v99.0.0')]))
    const good = await latest()
    await expect(latest(true)).rejects.toThrow(UNREACHABLE)
    expect(await latest()).toEqual(good)
  })
})
