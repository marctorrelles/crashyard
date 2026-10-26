import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { vitals } from '../data/performance'
import { storeTransaction, summarize } from './ingest'
import { rate, vitalsOf } from './vitals'

const NOW = Date.UTC(2026, 9, 26, 12)
const m = (value: number, unit = 'millisecond') => ({ value, unit })

// As @sentry/browser's pageload and sentry-cocoa's or sentry-android's app start send them
const browser = (lcp: number, release = '1.1') => ({
  transaction: '/songs',
  release,
  start_timestamp: NOW / 1000 - 2,
  timestamp: NOW / 1000,
  contexts: { trace: { op: 'pageload', status: 'ok' } },
  measurements: { lcp: m(lcp), fcp: m(800), inp: m(350), cls: m(0.05, ''), ttfb: m(0.15, 'second') },
})
const mobile = {
  transaction: 'SongView',
  release: '1.1',
  start_timestamp: NOW / 1000 - 1,
  timestamp: NOW / 1000,
  measurements: {
    app_start_cold: m(6200),
    app_start_warm: m(900),
    time_to_initial_display: m(1500),
    time_to_full_display: m(2600),
    frames_total: m(200, 'none'),
    frames_slow: m(10, 'none'),
    frames_frozen: m(1, 'none'),
  },
}

describe('vitals', () => {
  it('reads web and mobile measurements in their units', () => {
    expect(vitalsOf(browser(2000).measurements)).toEqual([
      { vital: 'lcp', stored: 2000 },
      { vital: 'inp', stored: 350 },
      { vital: 'cls', stored: 50 },
      { vital: 'fcp', stored: 800 },
      { vital: 'ttfb', stored: 150 },
    ])
    expect(vitalsOf(mobile.measurements)).toEqual([
      { vital: 'app_start_cold', stored: 6200 },
      { vital: 'app_start_warm', stored: 900 },
      { vital: 'time_to_initial_display', stored: 1500 },
      { vital: 'time_to_full_display', stored: 2600 },
      { vital: 'frames_slow_rate', stored: 500 },
      { vital: 'frames_frozen_rate', stored: 50 },
    ])
    expect(vitalsOf({ lcp: { value: 'x' }, frames_total: m(0, 'none'), frames_slow: m(3, 'none') })).toEqual([])
  })

  it('rates each by Sentry’s thresholds', () => {
    expect([rate('lcp', 1200), rate('lcp', 2400), rate('lcp', 2401)]).toEqual(['good', 'meh', 'poor'])
    expect([rate('cls', 0.1), rate('cls', 0.2), rate('cls', 0.3)]).toEqual(['good', 'meh', 'poor'])
    expect([rate('inp', 200), rate('fcp', 1000), rate('ttfb', 500)]).toEqual(['good', 'meh', 'poor'])
    expect([rate('app_start_cold', 2900), rate('app_start_cold', 4000), rate('app_start_cold', 6000)]).toEqual([
      'good',
      'meh',
      'poor',
    ])
    expect([rate('app_start_warm', 1500), rate('time_to_initial_display', 2500)]).toEqual(['meh', 'poor'])
    expect([rate('time_to_full_display', 9000), rate('frames_slow_rate', 50), rate('lcp', null)]).toEqual([
      null,
      null,
      null,
    ])
  })

  it('gives p75 per vital from the stored histograms, with the change since the release before', async () => {
    const db = sqliteD1()
    db.sqlite.exec("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'k', 0)")
    const store = async (raw: Record<string, unknown>, at: number) =>
      storeTransaction(db, 1, summarize({ ...raw, event_id: crypto.randomUUID() }, at)!, at)
    for (const lcp of [900, 950, 3000, 5000]) await store(browser(lcp, '1.0'), NOW - 3 * 3_600_000)
    for (const lcp of [1000, 1000, 1000, 1000]) await store(browser(lcp), NOW - 3_600_000)
    await store(mobile, NOW)
    const out = new Map((await vitals(db, 1, 7, NOW)).map((v) => [v.vital, v]))
    const lcp = out.get('lcp')!
    // Eight page loads: the 6th of 8 is 1,000 ms, read as its bucket's top, within 20%
    expect(lcp.count).toBe(8)
    expect(lcp.p75).toBeGreaterThanOrEqual(1000)
    expect(lcp.p75).toBeLessThanOrEqual(1200)
    expect(lcp.rating).toBe('good')
    expect(lcp.change).toBeLessThan(-0.5)
    expect(out.get('cls')!.p75).toBeCloseTo(0.05, 1)
    expect(out.get('inp')!.rating).toBe('meh')
    expect(out.get('app_start_cold')!.rating).toBe('poor')
    // 10 slow frames of 200: 5%, as its bucket's top
    expect(out.get('frames_slow_rate')!.p75).toBeGreaterThanOrEqual(5)
    expect(out.get('frames_slow_rate')!.p75).toBeLessThanOrEqual(6)
    expect(out.get('frames_frozen_rate')!.rating).toBeNull()
    // One transaction's own
    expect((await vitals(db, 1, 7, NOW, 'SongView')).map((v) => v.vital)).not.toContain('lcp')
  })
})
