import { describe, expect, it } from 'vitest'
import { newer } from './updates'

describe('newer', () => {
  it('compares versions part by part, as numbers', () => {
    expect(newer('v1.10.0', '1.9.2')).toBe(true)
    expect(newer('0.1.0', '0.1.0')).toBe(false)
    expect(newer('0.1.0', '0.2.0')).toBe(false)
  })
})
