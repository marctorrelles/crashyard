import { describe, expect, it } from 'vitest'
import { bucketOf, percentile } from './histogram'

describe('histograms', () => {
  it('give percentiles within a bucket’s width of the real ones', () => {
    const durations = Array.from({ length: 1000 }, (_, i) => i + 1) // 1..1000 ms
    const counts = new Map<number, number>()
    for (const d of durations) counts.set(bucketOf(d), (counts.get(bucketOf(d)) ?? 0) + 1)
    for (const [q, real] of [
      [0.5, 500],
      [0.95, 950],
      [0.99, 990],
    ]) {
      const p = percentile(counts, q)!
      expect(p).toBeGreaterThanOrEqual(real)
      expect(p).toBeLessThanOrEqual(real * 1.2)
    }
    expect(percentile(new Map(), 0.5)).toBeNull()
  })
})
