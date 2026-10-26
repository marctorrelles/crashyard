import { describe, expect, it } from 'vitest'
import { hourly, readsHours } from './logs'

const HOUR = 36e5
const DAY = 864e5

describe('logs', () => {
  it('reads the hourly rollup for hours and days of level and project alone', () => {
    for (const q of ['', 'level:error', '!level:[debug,trace] project:a', '!project:[a,b] level:warning'])
      expect(readsHours(q, '1h', 7 * DAY), q).toBe(true)
    expect(readsHours('', '1d', 30 * DAY)).toBe(true)
    // A word, any other key, a minute's buckets or a span of part-hours read the logs
    for (const q of ['crash', 'level:error slow', 'release:1.0', 'song:42', 'has:song', 'message:x', 'trace:abc'])
      expect(readsHours(q, '1h', 7 * DAY), q).toBe(false)
    expect(readsHours('', '5m', 6 * HOUR)).toBe(false)
    expect(readsHours('', '1m', HOUR)).toBe(false)
    expect(readsHours('', '1d', 30 * DAY + 1)).toBe(false)
  })

  it('takes a span’s whole hours from the rollup and the part-hours at its ends from the logs', () => {
    const from = Date.UTC(2026, 9, 1, 10, 30)
    const to = Date.UTC(2026, 9, 2, 10, 30)
    expect(hourly([[from, to]]).params).toEqual([
      Date.UTC(2026, 9, 1, 11),
      Date.UTC(2026, 9, 2, 10),
      from,
      Date.UTC(2026, 9, 1, 11),
      Date.UTC(2026, 9, 2, 10),
      to,
    ])
    // On the hour, the logs' parts are empty; within one hour, it's all logs
    expect(hourly([[Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 2)]]).params).toEqual([
      Date.UTC(2026, 9, 1),
      Date.UTC(2026, 9, 2),
      Date.UTC(2026, 9, 1),
      Date.UTC(2026, 9, 1),
      Date.UTC(2026, 9, 2),
      Date.UTC(2026, 9, 2),
    ])
    const [a, b] = [Date.UTC(2026, 9, 1, 10, 10), Date.UTC(2026, 9, 1, 10, 50)]
    expect(hourly([[a, b]]).params).toEqual([b, b, a, b, b, b])
    // Two spans, two terms each: D1 allows five in a compound SELECT
    expect(
      hourly([
        [a, b],
        [b, b + HOUR],
      ]).sql.match(/UNION ALL/g),
    ).toHaveLength(3)
  })
})
