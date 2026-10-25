import { describe, expect, it } from 'vitest'
import { nextCrontab, nextRun, parseCrontab } from './schedule'

const at = (iso: string) => Date.parse(iso)
const next = (cron: string, after: string, tz?: string) =>
  new Date(nextCrontab(parseCrontab(cron), at(after), tz)).toISOString()

describe('schedules', () => {
  it('finds the next minute a crontab runs', () => {
    expect(next('*/15 * * * *', '2026-10-25T10:07:30Z')).toBe('2026-10-25T10:15:00.000Z')
    expect(next('0 3 * * *', '2026-10-25T03:00:00Z')).toBe('2026-10-26T03:00:00.000Z')
    expect(next('30 9 * * 1-5', '2026-10-24T12:00:00Z')).toBe('2026-10-26T09:30:00.000Z') // Saturday → Monday
    expect(next('@monthly', '2026-10-25T00:00:00Z')).toBe('2026-11-01T00:00:00.000Z')
    expect(next('0 0 13 * 5', '2026-10-25T00:00:00Z')).toBe('2026-10-30T00:00:00.000Z') // a Friday, or the 13th
  })

  it('keeps the wall clock of a time zone, across daylight saving', () => {
    // 03:00 in Madrid: CEST (UTC+2) on 24 October, CET (UTC+1) after the clocks go back on the 25th
    expect(next('0 3 * * *', '2026-10-24T00:00:00Z', 'Europe/Madrid')).toBe('2026-10-24T01:00:00.000Z')
    expect(next('0 3 * * *', '2026-10-25T00:00:00Z', 'Europe/Madrid')).toBe('2026-10-25T02:00:00.000Z')
  })

  it('adds intervals, months by the calendar', () => {
    expect(nextRun({ type: 'interval', value: 30, unit: 'minute' }, at('2026-10-25T10:00:00Z'))).toBe(
      at('2026-10-25T10:30:00Z'),
    )
    expect(nextRun({ type: 'interval', value: 1, unit: 'month' }, at('2026-01-31T00:00:00Z'))).toBe(
      at('2026-03-03T00:00:00Z'),
    )
  })

  it('refuses what cron wouldn’t read', () => {
    expect(() => parseCrontab('61 * * * *')).toThrow()
    expect(() => parseCrontab('* * *')).toThrow()
  })
})
