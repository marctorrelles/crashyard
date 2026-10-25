// Small pieces the pages share: a sparkline, "3h ago", an issue's level and status.
import { cn } from '@/lib/utils'

/** Bars for a count per day, oldest first */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const max = Math.max(1, ...values)
  const w = 4
  const gap = 1.5
  return (
    <svg
      viewBox={`0 0 ${values.length * (w + gap) - gap} 24`}
      preserveAspectRatio="none"
      className={cn('h-6 w-24 text-muted-foreground/60', className)}
      aria-label={`${values.reduce((a, b) => a + b, 0)} events in ${values.length} days`}
      role="img"
    >
      {values.map((v, i) => {
        const h = v ? Math.max(2, (v / max) * 24) : 1
        return (
          <rect
            key={i}
            x={i * (w + gap)}
            y={24 - h}
            width={w}
            height={h}
            rx={1}
            className={v ? 'fill-current' : 'fill-border'}
          />
        )
      })}
    </svg>
  )
}

const UNITS: [number, string][] = [
  [31_536_000_000, 'y'],
  [2_592_000_000, 'mo'],
  [604_800_000, 'w'],
  [86_400_000, 'd'],
  [3_600_000, 'h'],
  [60_000, 'm'],
]

/** How long ago, short ("3h"); `now` comes from the server so the page renders the same on both sides */
export function ago(at: number, now: number) {
  const d = Math.max(0, now - at)
  for (const [ms, unit] of UNITS) if (d >= ms) return `${Math.floor(d / ms)}${unit} ago`
  return 'just now'
}

export function Ago({ at, now, className }: { at: number; now: number; className?: string }) {
  const date = new Date(at)
  return (
    <time dateTime={date.toISOString()} title={date.toUTCString()} className={cn('whitespace-nowrap', className)}>
      {ago(at, now)}
    </time>
  )
}

const LEVEL_COLOR: Record<string, string> = {
  fatal: 'bg-red-600',
  error: 'bg-orange-500',
  warning: 'bg-amber-400',
  info: 'bg-sky-500',
  debug: 'bg-zinc-400',
}

export function Level({ level, label }: { level: string; label?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title={level}>
      <span className={cn('size-2 shrink-0 rounded-full', LEVEL_COLOR[level] ?? 'bg-zinc-400')} />
      {label && level}
    </span>
  )
}

export const count = (n: number) =>
  n < 1000
    ? String(n)
    : n < 1e6
      ? `${(n / 1000).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '')}k`
      : `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
