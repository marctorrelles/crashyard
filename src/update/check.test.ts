import { describe, expect, it } from 'vitest'
import { BUILDER_NOTE, BUNDLE, newer, pick, type Release } from './check'

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
