import { describe, expect, it } from 'vitest'
import { nextPath } from './next'

describe('next', () => {
  it('keeps a path on this site, and sends anything a browser reads as another site home', () => {
    expect(nextPath('/issues/12?event=a#tags')).toBe('/issues/12?event=a#tags')
    for (const away of ['//evil.com', '/\\evil.com', '/\t/evil.com', 'https://evil.com', 'evil.com', '', null])
      expect(nextPath(away), String(away)).toBe('/')
  })
})
