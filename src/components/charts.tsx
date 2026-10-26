// Charts the lists share: counts over time (stacked series, the period before as a dashed line, drag to zoom), a
// value's share of a total with include and exclude, and one number with its change. shadcn's chart over recharts.
import { ClientOnly } from '@tanstack/react-router'
import { MinusIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { Area, Bar, CartesianGrid, ComposedChart, Line, ReferenceArea, XAxis, YAxis } from 'recharts'
import { count } from '@/components/bits'
import { Button } from '@/components/ui/button'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export type Series = { key: string; label: string; values: number[]; color?: string }

/** A level's colour in the charts, most severe the darkest red */
export const LEVEL_COLORS: Record<string, string> = {
  fatal: 'var(--color-red-700)',
  error: 'var(--color-red-500)',
  warning: 'var(--color-amber-500)',
  info: 'var(--color-sky-500)',
  debug: 'var(--muted-foreground)',
}

const DAY = 864e5
// A day (`YYYY-MM-DD`) is a UTC day: written as that day wherever the browser is. A bucket start (ms) shorter than a
// day is written in the browser's time.
const startOf = (x: number | string) => (typeof x === 'string' ? Date.parse(`${x}T00:00:00Z`) : x)
function tick(x: number | string, step: number) {
  const at = new Date(startOf(x))
  if (typeof x === 'string' || step >= DAY)
    return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
function title(x: number | string, step: number) {
  const at = new Date(startOf(x))
  if (typeof x === 'string' || step >= DAY)
    return at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
  return at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

type Props = {
  x: number[] | string[]
  series: Series[]
  previous?: number[]
  kind?: 'bar' | 'area' | 'line'
  height?: number
  className?: string
  onZoom?: (from: number, to: number) => void
  format?: (v: number) => string
}

/**
 * Counts per bucket, stacked (lines aren't): `x` is bucket starts in ms or UTC days. Labels are in the browser's
 * locale and time, so it draws once hydrated, a skeleton of its size before. `className` can set the height per
 * screen size (`h-30 md:h-50`); `height` is the fixed one otherwise.
 */
export function TimeChart(props: Props) {
  const size = cn('w-full', props.className)
  const style = props.className ? undefined : { height: props.height ?? 160 }
  return (
    <ClientOnly fallback={<Skeleton className={size} style={style} />}>
      <Chart {...props} size={size} style={style} />
    </ClientOnly>
  )
}

function Chart({
  x,
  series,
  previous,
  kind = 'bar',
  onZoom,
  format = count,
  size,
  style,
}: Props & { size: string; style?: React.CSSProperties }) {
  // The buckets a drag has covered so far, by index
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)
  const step = x.length > 1 ? startOf(x[1]) - startOf(x[0]) : DAY
  const config: ChartConfig = Object.fromEntries([
    ...series.map((s, i) => [
      s.key,
      { label: s.label, color: s.color ?? LEVEL_COLORS[s.key] ?? `var(--chart-${(i % 5) + 1})` },
    ]),
    ['previous', { label: 'Period before', color: 'var(--muted-foreground)' }],
  ])
  const rows = x.map((_, i) => ({
    i,
    ...Object.fromEntries(series.map((s) => [s.key, s.values[i] ?? 0])),
    ...(previous ? { previous: previous[i] ?? 0 } : {}),
  }))
  const indexOf = (state: { activeIndex?: number | string | null }) =>
    state.activeIndex === undefined || state.activeIndex === null ? undefined : Number(state.activeIndex)
  const stack = kind === 'line' ? undefined : 'counts'
  return (
    <ChartContainer
      config={config}
      className={cn('aspect-auto select-none', onZoom && 'cursor-crosshair', size)}
      style={style}
    >
      <ComposedChart
        data={rows}
        margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
        onMouseDown={(state) => {
          const at = indexOf(state)
          if (onZoom && at !== undefined) setDrag({ from: at, to: at })
        }}
        onMouseMove={(state) => {
          const at = indexOf(state)
          if (drag && at !== undefined && at !== drag.to) setDrag({ ...drag, to: at })
        }}
        onMouseUp={() => {
          if (drag && onZoom && drag.from !== drag.to) {
            const [a, b] = [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)]
            onZoom(startOf(x[a]), startOf(x[b]) + step)
          }
          setDrag(null)
        }}
        onMouseLeave={() => setDrag(null)}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="i"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={28}
          tickFormatter={(i: number) => (x[i] === undefined ? '' : tick(x[i], step))}
        />
        <YAxis width={36} tickLine={false} axisLine={false} allowDecimals={false} tickFormatter={format} />
        <ChartTooltip
          cursor={kind === 'bar' ? { fill: 'var(--muted)', opacity: 0.6 } : true}
          content={
            <ChartTooltipContent
              className="min-w-40"
              labelFormatter={(_, payload) => {
                const i = (payload[0]?.payload as { i?: number } | undefined)?.i
                return i === undefined ? '' : title(x[i], step)
              }}
            />
          }
        />
        {series.map((s) =>
          kind === 'bar' ? (
            <Bar key={s.key} dataKey={s.key} stackId={stack} fill={`var(--color-${s.key})`} isAnimationActive={false} />
          ) : kind === 'area' ? (
            <Area
              key={s.key}
              dataKey={s.key}
              stackId={stack}
              type="monotone"
              stroke={`var(--color-${s.key})`}
              fill={`var(--color-${s.key})`}
              fillOpacity={0.3}
              isAnimationActive={false}
            />
          ) : (
            <Line
              key={s.key}
              dataKey={s.key}
              type="monotone"
              stroke={`var(--color-${s.key})`}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          ),
        )}
        {previous && (
          <Line
            dataKey="previous"
            type="monotone"
            stroke="var(--color-previous)"
            strokeDasharray="4 4"
            strokeWidth={1.5}
            dot={false}
            activeDot={false}
            isAnimationActive={false}
          />
        )}
        {drag && drag.from !== drag.to && (
          <ReferenceArea x1={Math.min(drag.from, drag.to)} x2={Math.max(drag.from, drag.to)} fillOpacity={0.15} />
        )}
      </ComposedChart>
    </ChartContainer>
  )
}

const share = (n: number, total: number) => {
  const r = total > 0 ? n / total : 0
  return r > 0 && r < 0.01 ? '<1%' : `${Math.round(r * 100)}%`
}

/** Values with their share of `total` as a bar, the count and percent; + shows only that value, − leaves it out */
export function BarList({
  items,
  total,
  onInclude,
  onExclude,
}: {
  items: { value: string; count: number }[]
  total: number
  onInclude?: (v: string) => void
  onExclude?: (v: string) => void
}) {
  // Shown on hover where there's a pointer that hovers; always on touch
  const action = 'max-sm:size-10 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 focus-visible:opacity-100'
  return (
    <ul className="grid gap-1">
      {items.map((it) => (
        <li key={it.value} className="group flex items-center gap-0.5 text-xs">
          <div className="relative min-w-0 flex-1 overflow-hidden rounded-md">
            <div
              className="absolute inset-y-0 left-0 bg-muted"
              style={{ width: `${total > 0 ? Math.min(100, (it.count / total) * 100) : 0}%` }}
            />
            <div className="relative flex justify-between gap-2 px-2 py-1 max-sm:py-2.5">
              <span className="truncate font-mono" title={it.value}>
                {it.value}
              </span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {count(it.count)} · {share(it.count, total)}
              </span>
            </div>
          </div>
          {onInclude && (
            <Button
              variant="ghost"
              size="icon-xs"
              className={action}
              aria-label={`Show only ${it.value}`}
              title="Show only this"
              onClick={() => onInclude(it.value)}
            >
              <PlusIcon />
            </Button>
          )}
          {onExclude && (
            <Button
              variant="ghost"
              size="icon-xs"
              className={action}
              aria-label={`Exclude ${it.value}`}
              title="Exclude this"
              onClick={() => onExclude(it.value)}
            >
              <MinusIcon />
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * One number, what it is, and its change against the period before (more reads red: these count what went wrong).
 * @public Not on a page yet: the overview takes it up next.
 */
export function BigNumber({
  value,
  label,
  change,
  format = count,
}: {
  value: number | null
  label: string
  change?: number | null
  format?: (v: number) => string
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{value === null ? '—' : format(value)}</span>
        {change !== undefined && change !== null && (
          <span
            className={cn(
              'text-xs tabular-nums',
              change > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400',
              change === 0 && 'text-muted-foreground',
            )}
          >
            {change > 0 ? '+' : change < 0 ? '−' : '±'}
            {Math.round(Math.abs(change) * 100)}%
          </span>
        )}
      </p>
    </div>
  )
}
