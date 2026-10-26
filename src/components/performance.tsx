// Pieces of the performance pages: durations, the period picker and a span waterfall.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Span } from '@/performance/ingest'
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
