import { describe, expect, it } from 'vitest'
import { likePrefix } from './suggest'

describe('suggestions', () => {
  it('escapes LIKE’s own % _ and \\ in a prefix, then matches anything after', () => {
    expect(likePrefix('')).toBe('%')
    expect(likePrefix('1.0')).toBe('1.0%')
    expect(likePrefix('50%')).toBe('50\\%%')
    expect(likePrefix('a_b')).toBe('a\\_b%')
    expect(likePrefix('C:\\x')).toBe('C:\\\\x%')
    expect(likePrefix('%_\\')).toBe('\\%\\_\\\\%')
  })
})
