// Charts the lists share: counts over time (stacked series, the period before as a dashed line, drag to zoom), a
// value's share of a total with include and exclude, and one number with its change. shadcn's chart over recharts.
import { ClientOnly } from '@tanstack/react-router'
import { IconMinus, IconPlus } from '@tabler/icons-react'
import { useState } from 'react'
import { Area, Bar, CartesianGrid, ComposedChart, Line, ReferenceArea, XAxis, YAxis } from 'recharts'
import { count } from '@/components/bits'
import { formatTime, type TimePrefs, useTimePrefs } from '@/components/time'
import { Button } from '@/components/ui/button'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import { useFinePointer } from '@/hooks/use-fine-pointer'
import { cn } from '@/lib/utils'

/**
 * One series: `key` names it in CSS (letters, digits, `-`), `values` a count per bucket (null draws a gap in a line).
 * `kind` overrides the chart's for this one; `axis: 'right'` measures it on a second axis.
 */
export type Series = {
  key: string
  label: string
  values: (number | null)[]
  color?: string
  kind?: 'bar' | 'area' | 'line'
  axis?: 'right'
}

/** A level's colour in the charts (issues' levels and logs'), the same as `Level`'s dot; logs' trace fainter than debug */
export const LEVEL_COLORS: Record<string, string> = {
  fatal: 'var(--color-red-600)',
  error: 'var(--color-orange-500)',
  warning: 'var(--color-amber-400)',
  warn: 'var(--color-amber-400)',
  info: 'var(--color-sky-500)',
  debug: 'var(--color-zinc-400)',
  trace: 'color-mix(in oklab, var(--color-zinc-400) 50%, transparent)',
}
// The period before: the text's colour, faded, so it stands apart from the greys of debug and trace
const PREVIOUS_COLOR = 'color-mix(in oklab, var(--foreground) 45%, transparent)'

/** Colours for series that aren't levels (a group's values, projects), apart in light and dark */
export const PALETTE = [
  'var(--color-sky-500)',
  'var(--color-violet-500)',
  'var(--color-amber-500)',
  'var(--color-emerald-500)',
  'var(--color-rose-500)',
  'var(--color-cyan-500)',
  'var(--color-lime-500)',
  'var(--color-fuchsia-500)',
]

const DAY = 864e5
// A day (`YYYY-MM-DD`) is a UTC day: written as that day wherever the viewer is. A bucket start (ms) shorter than a
// day is written in the viewer's zone and clock (Settings, Preferences)
const startOf = (x: number | string) => (typeof x === 'string' ? Date.parse(`${x}T00:00:00Z`) : x)
const utc = (prefs: TimePrefs): TimePrefs => ({ ...prefs, zone: 'UTC' })
function tick(x: number | string, step: number, prefs: TimePrefs) {
  if (typeof x === 'string' || step >= DAY) return formatTime(startOf(x), utc(prefs), 'day')
  return formatTime(x, prefs, 'time')
}
// The buckets that start a day in the viewer's zone (shorter buckets than a day), for ticks that say the date
function dayStarts(x: number[] | string[], step: number, prefs: TimePrefs): number[] {
  if (step >= DAY || typeof x[0] !== 'number') return []
  const days = (x as number[]).map((at) => formatTime(at, prefs, 'key'))
  return days.flatMap((d, i) => (i > 0 && d !== days[i - 1] ? [i] : []))
}
function title(x: number | string, step: number, prefs: TimePrefs) {
  if (typeof x === 'string' || step >= DAY) return formatTime(startOf(x), utc(prefs), 'weekday')
  return formatTime(x, prefs, 'dayTime')
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
  formatRight?: (v: number) => string
  // Bars and areas are stacked unless this is false (side by side)
  stacked?: boolean
  legend?: boolean
  // A click on a series' bar, area or line (a dashboard's widget opens the list of that value); with a mouse only, so
  // a tap on a phone shows the tooltip
  onSeries?: (key: string) => void
}

/**
 * Counts per bucket, stacked (lines aren't): `x` is bucket starts in ms or UTC days. Labels are in the viewer's zone
 * and clock; it draws once hydrated (recharts measures the page), a skeleton of its size before. `className` can set the height per
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
  formatRight = count,
  stacked = true,
  legend = false,
  onSeries,
  size,
  style,
}: Props & { size: string; style?: React.CSSProperties }) {
  // The buckets a drag has covered so far, by index
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)
  const fine = useFinePointer()
  const prefs = useTimePrefs()
  const step = x.length > 1 ? startOf(x[1]) - startOf(x[0]) : DAY
  // Over two days or more of hours, a tick a day, with its date; over less, a tick that starts a day says its date
  const starts = dayStarts(x, step, prefs)
  const daily = starts.length > 0 && x.length * step >= 2 * DAY
  const startsAt = new Set(starts)
  const config: ChartConfig = Object.fromEntries([
    ...series.map((s, i) => [
      s.key,
      { label: s.label, color: s.color ?? LEVEL_COLORS[s.key] ?? `var(--chart-${(i % 5) + 1})` },
    ]),
    ['previous', { label: 'Period before', color: PREVIOUS_COLOR }],
  ])
  const rows = x.map((_, i) => ({
    i,
    ...Object.fromEntries(series.map((s) => [s.key, s.values[i] === undefined ? 0 : s.values[i]])),
    ...(previous ? { previous: previous[i] ?? 0 } : {}),
  }))
  const indexOf = (state: { activeIndex?: number | string | null }) =>
    state.activeIndex === undefined || state.activeIndex === null ? undefined : Number(state.activeIndex)
  const right = series.some((s) => s.axis === 'right')
  const chart = (
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
          ticks={daily ? starts : undefined}
          tickFormatter={(i: number) =>
            x[i] === undefined
              ? ''
              : startsAt.has(i)
                ? formatTime(x[i] as number, prefs, 'day')
                : tick(x[i], step, prefs)
          }
        />
        <YAxis
          yAxisId="left"
          width={format === count ? 36 : 52}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
          tickFormatter={format}
        />
        {right && (
          <YAxis
            yAxisId="right"
            orientation="right"
            width={formatRight === count ? 36 : 52}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            tickFormatter={formatRight}
          />
        )}
        <ChartTooltip
          cursor={kind === 'bar' ? { fill: 'var(--muted)', opacity: 0.6 } : true}
          // Above the axes and the series drawn after it
          wrapperStyle={{ zIndex: 10 }}
          content={
            <ChartTooltipContent
              className="max-w-72 min-w-40"
              labelFormatter={(_, payload) => {
                const i = (payload[0]?.payload as { i?: number } | undefined)?.i
                return i === undefined ? '' : title(x[i], step, prefs)
              }}
            />
          }
        />
        {series.map((s) => {
          const as = s.kind ?? kind
          const axis = s.axis ?? 'left'
          // Lines aren't stacked; bars and areas are, each kind on each axis apart
          const stack = stacked && as !== 'line' ? `${as}-${axis}` : undefined
          const click = onSeries && fine && { onClick: () => onSeries(s.key), className: 'cursor-pointer' }
          return as === 'bar' ? (
            <Bar
              key={s.key}
              {...click}
              yAxisId={axis}
              dataKey={s.key}
              stackId={stack}
              fill={`var(--color-${s.key})`}
              isAnimationActive={false}
            />
          ) : as === 'area' ? (
            <Area
              key={s.key}
              {...click}
              yAxisId={axis}
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
              {...click}
              yAxisId={axis}
              dataKey={s.key}
              type="monotone"
              stroke={`var(--color-${s.key})`}
              strokeWidth={2}
              // A bucket with nothing to measure (a p95 of no transactions) is skipped, not drawn as zero
              connectNulls
              dot={false}
              isAnimationActive={false}
            />
          )
        })}
        {previous && (
          <Line
            yAxisId="left"
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
          <ReferenceArea
            yAxisId="left"
            x1={Math.min(drag.from, drag.to)}
            x2={Math.max(drag.from, drag.to)}
            fillOpacity={0.15}
          />
        )}
      </ComposedChart>
    </ChartContainer>
  )
  if (!legend) return chart
  // Under the chart rather than recharts' own, which takes its lines out of the chart's height
  return (
    <div>
      {chart}
      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 pt-3 text-xs wrap-anywhere">
        {Object.entries(config)
          .filter(([key]) => key !== 'previous' || previous)
          .map(([key, c]) => (
            <li key={key} className="flex items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-[2px]" style={{ background: c.color }} />
              {c.label}
            </li>
          ))}
      </ul>
    </div>
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
  format,
}: {
  items: { value: string; count: number }[]
  total: number
  onInclude?: (v: string) => void
  onExclude?: (v: string) => void
  // What's written beside a value instead of its count and share
  format?: (count: number) => string
}) {
  // With a pointer that hovers, Show only and Exclude float just above the row, at its end, taking no room: on hover
  // or once tabbed to (the padding under them keeps the hover while the pointer moves up). On touch, + and − follow
  // the row, always there. One track that never grows past the list, so a long value truncates
  const actions = onInclude || onExclude
  const above =
    'pointer-fine:pointer-events-none pointer-fine:absolute pointer-fine:right-0 pointer-fine:bottom-full pointer-fine:z-20 pointer-fine:pb-1 pointer-fine:opacity-0 pointer-fine:transition-opacity pointer-fine:group-focus-within:pointer-events-auto pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:pointer-events-auto pointer-fine:group-hover:opacity-100'
  return (
    <ul className="grid grid-cols-1 gap-1">
      {items.map((it) => (
        <li key={it.value} className="group relative flex items-center gap-0.5 text-xs">
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
                {format ? format(it.count) : `${count(it.count)} · ${share(it.count, total)}`}
              </span>
            </div>
          </div>
          {actions && (
            <div className={cn('shrink-0', above)}>
              <div className="flex gap-0.5 pointer-fine:rounded-md pointer-fine:border pointer-fine:bg-popover pointer-fine:p-0.5 pointer-fine:shadow-md">
                {onInclude && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="pointer-coarse:size-10 pointer-coarse:px-0"
                    aria-label={`Show only ${it.value}`}
                    onClick={() => onInclude(it.value)}
                  >
                    <IconPlus />
                    <span className="pointer-coarse:sr-only">Show only</span>
                  </Button>
                )}
                {onExclude && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="pointer-coarse:size-10 pointer-coarse:px-0"
                    aria-label={`Exclude ${it.value}`}
                    onClick={() => onExclude(it.value)}
                  >
                    <IconMinus />
                    <span className="pointer-coarse:sr-only">Exclude</span>
                  </Button>
                )}
              </div>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * One number, what it is, and its change against the period before (more reads red: these count what went wrong,
 * unless `higherIsBetter`, as a crash-free rate). `tone` colours it past a widget's thresholds
 */
export function BigNumber({
  value,
  label,
  change,
  format = count,
  tone,
  higherIsBetter,
}: {
  value: number | null
  label: string
  change?: number | null
  format?: (v: number) => string
  tone?: 'warning' | 'critical'
  higherIsBetter?: boolean
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="flex items-baseline gap-2">
        <span
          className={cn(
            'text-2xl font-semibold tabular-nums',
            tone === 'warning' && 'text-amber-600 dark:text-amber-400',
            tone === 'critical' && 'text-red-600 dark:text-red-400',
          )}
        >
          {value === null ? '—' : format(value)}
        </span>
        {change !== undefined && change !== null && (
          <Change percent={Math.round(change * 100)} higherIsBetter={higherIsBetter} />
        )}
      </p>
    </div>
  )
}

// A change as it reads, one set of classes a state: more red, less green (the other way round when higher is
// better), none (as rounded) muted
function Change({ percent, higherIsBetter }: { percent: number; higherIsBetter?: boolean }) {
  const worse = 'text-red-600 dark:text-red-400'
  const better = 'text-emerald-600 dark:text-emerald-400'
  const [sign, color] =
    percent > 0
      ? ['+', higherIsBetter ? better : worse]
      : percent < 0
        ? ['−', higherIsBetter ? worse : better]
        : ['±', 'text-muted-foreground']
  return (
    <span className={cn('text-xs tabular-nums', color)}>
      {sign}
      {Math.abs(percent)}%
    </span>
  )
}
