// Pieces of the performance pages: durations, the period picker, vitals and a span waterfall.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { VitalSummary } from '@/data/performance'
import type { Span } from '@/performance/ingest'
import { MOBILE_VITALS, type Rating, RATING_LABELS, VITALS, type Vital, WEB_VITALS } from '@/performance/vitals'
import { cn } from '@/lib/utils'

/** A duration, short: 840 ms, 2.4 s, 3.1 min */
export const ms = (v: number | null) =>
  v === null
    ? '–'
    : v < 1000
      ? `${Math.round(v)} ms`
      : v < 60_000
        ? `${(v / 1000).toFixed(1)} s`
        : `${(v / 60_000).toFixed(1)} min`

const PERIODS = { 1: 'Last 24 hours', 7: 'Last 7 days', 30: 'Last 30 days' } as Record<number, string>

export function Period({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  return (
    <Select value={String(days)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="w-36" aria-label="Period">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {Object.entries(PERIODS).map(([value, label]) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

const OP_COLORS = ['bg-sky-500', 'bg-violet-500', 'bg-amber-500', 'bg-emerald-500', 'bg-rose-500', 'bg-cyan-500']

/** Spans as bars across the transaction's duration, indented by depth */
export function Waterfall({ spans, duration }: { spans: Span[]; duration: number }) {
  if (spans.length === 0) return <p className="px-4 py-3 text-sm text-muted-foreground">No spans in this one.</p>
  const ops = [...new Set(spans.map((s) => s.op))]
  return (
    <ul className="grid gap-px px-4 py-3 text-xs">
      {spans.map((s, i) => (
        <li
          key={i}
          className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-3 max-sm:grid-cols-1 max-sm:gap-0.5 max-sm:py-1"
        >
          <p className="truncate" style={{ paddingLeft: `${Math.min(s.depth, 6) * 0.75}rem` }} title={s.description}>
            <span className="font-medium">{s.op}</span> <span className="text-muted-foreground">{s.description}</span>
          </p>
          <div className="relative h-4">
            <div
              className={cn(
                'absolute inset-y-0.5 min-w-0.5 rounded-sm',
                OP_COLORS[ops.indexOf(s.op) % OP_COLORS.length],
                s.status && s.status !== 'ok' && 'ring-2 ring-red-500',
              )}
              style={{ left: `${(s.start / duration) * 100}%`, width: `${(s.duration / duration) * 100}%` }}
            />
            <span
              className="absolute top-0 text-[10px] leading-4 text-muted-foreground tabular-nums"
              style={
                s.start / duration > 0.7
                  ? { right: `${100 - (s.start / duration) * 100}%`, marginRight: 4 }
                  : { left: `calc(${((s.start + s.duration) / duration) * 100}% + 4px)` }
              }
            >
              {ms(s.duration)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}

/** A vital's p75 in its unit */
export const vitalValue = (vital: Vital, v: number | null) =>
  v === null
    ? '–'
    : VITALS[vital].unit === 'ms'
      ? ms(v)
      : VITALS[vital].unit === 'percent'
        ? `${v.toFixed(v < 10 ? 1 : 0)}%`
        : v.toFixed(2)

const RATING_COLORS: Record<Rating, string> = {
  good: 'bg-emerald-500',
  meh: 'bg-amber-400',
  poor: 'bg-red-500',
}

/** "Web vitals" and "Mobile vitals", each vital measured as p75 with its rating and its change since the release before */
export function VitalRows({ vitals }: { vitals: VitalSummary[] }) {
  const rows = [
    ['Web vitals', WEB_VITALS],
    ['Mobile vitals', MOBILE_VITALS],
  ] as const
  return (
    <>
      {rows.map(([title, kinds]) => {
        const shown = vitals.filter((v) => (kinds as readonly Vital[]).includes(v.vital))
        if (!shown.length) return null
        return (
          <section key={title} className="mb-4" aria-label={title}>
            <h3 className="mb-2 text-sm font-medium">
              {title} <span className="font-normal text-muted-foreground">p75</span>
            </h3>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {shown.map((v) => (
                <div key={v.vital} className="rounded-xl border p-3">
                  <dt className="truncate text-xs text-muted-foreground" title={VITALS[v.vital].label}>
                    {VITALS[v.vital].short}
                  </dt>
                  <dd className="text-lg font-semibold tabular-nums">{vitalValue(v.vital, v.p75)}</dd>
                  <dd className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {v.rating ? (
                      <>
                        <span className={cn('size-2 shrink-0 rounded-full', RATING_COLORS[v.rating])} />
                        {RATING_LABELS[v.rating]}
                      </>
                    ) : (
                      'Not rated'
                    )}
                  </dd>
                  {v.change !== null && (
                    <dd className="text-xs text-muted-foreground tabular-nums">
                      {Math.round(v.change * 100) === 0
                        ? 'Same as the release before'
                        : `${v.change > 0 ? 'Up' : 'Down'} ${Math.abs(Math.round(v.change * 100))}% on the release before`}
                    </dd>
                  )}
                </div>
              ))}
            </dl>
          </section>
        )
      })}
    </>
  )
}
