import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Update } from './check'
import { type Bundle, download, refusal } from './install'

const update: Update = {
  version: '0.2.0',
  current: '0.1.0',
  url: '',
  builder: false,
  major: false,
  bundle: { url: 'https://dl/b', digest: '' },
}
const bundle = { version: '0.2.0', worker: { bindings: ['DB', 'FILES', 'QUEUE'] } } as Bundle
const settings = {
  bindings: [
    { type: 'd1', name: 'DB' },
    { type: 'r2_bucket', name: 'FILES' },
  ],
}

describe('refusal', () => {
  it('leaves to a deploy a release without a build, a builder change where it runs, and a new binding', () => {
    expect(refusal({ ...update, bundle: null }, null, null, false)).toMatch(/no build/)
    expect(refusal({ ...update, builder: true }, null, null, true)).toMatch(/SymCache builder/)
    expect(refusal({ ...update, builder: true }, null, null, false)).toBeNull()
    expect(refusal(update, bundle, settings, false)).toMatch(/adds QUEUE/)
    expect(refusal(update, { ...bundle, worker: { ...bundle.worker, bindings: ['DB'] } }, settings, false)).toBeNull()
  })
})

describe('download', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('takes the build only when its SHA-256 is the one GitHub lists', async () => {
    const gzip = gzipSync(JSON.stringify(bundle))
    vi.stubGlobal('fetch', async () => new Response(gzip))
    const digest = `sha256:${Buffer.from(await crypto.subtle.digest('SHA-256', gzip)).toString('hex')}`
    expect((await download({ ...update, bundle: { url: 'x', digest } })).version).toBe('0.2.0')
    await expect(download({ ...update, bundle: { url: 'x', digest: 'sha256:00' } })).rejects.toThrow(/isn’t the one/)
    await expect(download({ ...update, version: '0.3.0', bundle: { url: 'x', digest } })).rejects.toThrow(/says it is/)
  })
})
