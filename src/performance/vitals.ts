// Web and mobile vitals: read from a transaction's `measurements` at ingest, kept as histograms (vital_buckets, the
// buckets of histogram.ts), shown as p75 with Sentry's rating. Pure: no D1 here, so pages import it.

export type Vital =
  | 'lcp'
  | 'fcp'
  | 'inp'
  | 'cls'
  | 'ttfb'
  | 'app_start_cold'
  | 'app_start_warm'
  | 'time_to_initial_display'
  | 'time_to_full_display'
  | 'frames_slow_rate'
  | 'frames_frozen_rate'

export type Rating = 'good' | 'meh' | 'poor'

type Info = {
  label: string
  /** What a card calls it: web vitals by their initials, as Sentry and browsers do */
  short: string
  kind: 'web' | 'mobile'
  unit: 'ms' | 'score' | 'percent'
  /** Stored as value × scale, so a histogram of whole numbers keeps it: CLS in thousandths, rates in hundredths of a percent */
  scale: number
  /** Good up to this, needs improvement up to `poor`, poor past it; none when Sentry rates it with no threshold */
  good?: number
  poor?: number
}

// Web: Sentry's performance score thresholds (static/app/views/insights/browser/webVitals/utils/scoreThresholds.tsx,
// PERFORMANCE_SCORE_P90S as good and PERFORMANCE_SCORE_MEDIANS as the edge of poor, master on 2026-10-27). Mobile:
// app starts from Sentry's Mobile Vitals docs (cold good under 3 s, poor past 5 s; warm 1 s and 2 s), TTID from
// static/app/utils/performance/vitals/constants.tsx (poor past 2 s, no other threshold, so good up to it); TTFD and
// frame rates have none there, so they're shown unrated
export const VITALS: Record<Vital, Info> = {
  lcp: { short: 'LCP', label: 'Largest contentful paint', kind: 'web', unit: 'ms', scale: 1, good: 1200, poor: 2400 },
  inp: { short: 'INP', label: 'Interaction to next paint', kind: 'web', unit: 'ms', scale: 1, good: 200, poor: 500 },
  cls: {
    short: 'CLS',
    label: 'Cumulative layout shift',
    kind: 'web',
    unit: 'score',
    scale: 1000,
    good: 0.1,
    poor: 0.25,
  },
  fcp: { short: 'FCP', label: 'First contentful paint', kind: 'web', unit: 'ms', scale: 1, good: 900, poor: 1600 },
  ttfb: { short: 'TTFB', label: 'Time to first byte', kind: 'web', unit: 'ms', scale: 1, good: 200, poor: 400 },
  app_start_cold: {
    short: 'Cold start',
    label: 'Cold start',
    kind: 'mobile',
    unit: 'ms',
    scale: 1,
    good: 3000,
    poor: 5000,
  },
  app_start_warm: {
    short: 'Warm start',
    label: 'Warm start',
    kind: 'mobile',
    unit: 'ms',
    scale: 1,
    good: 1000,
    poor: 2000,
  },
  time_to_initial_display: {
    short: 'Time to initial display',
    label: 'Time to initial display',
    kind: 'mobile',
    unit: 'ms',
    scale: 1,
    good: 2000,
    poor: 2000,
  },
  time_to_full_display: {
    short: 'Time to full display',
    label: 'Time to full display',
    kind: 'mobile',
    unit: 'ms',
    scale: 1,
  },
  frames_slow_rate: { short: 'Slow frames', label: 'Slow frames', kind: 'mobile', unit: 'percent', scale: 100 },
  frames_frozen_rate: { short: 'Frozen frames', label: 'Frozen frames', kind: 'mobile', unit: 'percent', scale: 100 },
}

export const WEB_VITALS = (Object.keys(VITALS) as Vital[]).filter((v) => VITALS[v].kind === 'web')
export const MOBILE_VITALS = (Object.keys(VITALS) as Vital[]).filter((v) => VITALS[v].kind === 'mobile')
export const isVital = (v: string): v is Vital => Object.hasOwn(VITALS, v)

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})

/** A measurement in ms, or as it is when it has no time unit; Sentry's `{ value, unit }` */
function measured(m: Json, key: string): number | undefined {
  const x = obj(m[key])
  const value = typeof x.value === 'number' && Number.isFinite(x.value) && x.value >= 0 ? x.value : undefined
  if (value === undefined) return undefined
  const unit = typeof x.unit === 'string' ? x.unit : ''
  return unit === 'second'
    ? value * 1000
    : unit === 'microsecond'
      ? value / 1000
      : unit === 'nanosecond'
        ? value / 1e6
        : value
}

/**
 * The vitals in a transaction's `measurements`, as stored (value × scale, whole): the browser SDK's `lcp`, `fcp`,
 * `inp`, `cls`, `ttfb`, and the mobile SDKs' `app_start_cold`, `app_start_warm`, `time_to_initial_display`,
 * `time_to_full_display`, and `frames_slow` and `frames_frozen` over `frames_total` as rates in percent
 */
export function vitalsOf(measurements: unknown): { vital: Vital; stored: number }[] {
  const m = obj(measurements)
  const out: { vital: Vital; stored: number }[] = []
  for (const vital of Object.keys(VITALS) as Vital[]) {
    if (vital === 'frames_slow_rate' || vital === 'frames_frozen_rate') continue
    const value = measured(m, vital)
    if (value !== undefined) out.push({ vital, stored: Math.round(value * VITALS[vital].scale) })
  }
  const total = measured(m, 'frames_total')
  if (total) {
    for (const [vital, key] of [
      ['frames_slow_rate', 'frames_slow'],
      ['frames_frozen_rate', 'frames_frozen'],
    ] as const) {
      const n = measured(m, key)
      if (n !== undefined) out.push({ vital, stored: Math.round(Math.min(1, n / total) * 100 * VITALS[vital].scale) })
    }
  }
  return out
}

/** A stored value back in the vital's unit */
export const fromStored = (vital: Vital, stored: number) => stored / VITALS[vital].scale

/** Good, needs improvement or poor by Sentry's thresholds; null for a vital it doesn't rate */
export function rate(vital: Vital, value: number | null): Rating | null {
  const { good, poor } = VITALS[vital]
  if (value === null || good === undefined || poor === undefined) return null
  return value <= good ? 'good' : value <= poor ? 'meh' : 'poor'
}

export const RATING_LABELS: Record<Rating, string> = { good: 'Good', meh: 'Needs improvement', poor: 'Poor' }
