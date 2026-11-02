// Pieces of the analytics pages: their tabs, stat tiles, the funnel's bars and the retention grid.
import { Link } from '@tanstack/react-router'
import { IconAlertTriangle } from '@tabler/icons-react'
import { count, Level } from '@/components/bits'
import { formatTime, useTimePrefs } from '@/components/time'
import { cn } from '@/lib/utils'

const TABS = [
  { to: '/analytics', label: 'Actions' },
  { to: '/analytics/funnel', label: 'Funnel' },
  { to: '/analytics/retention', label: 'Retention' },
] as const

/** Actions, Funnel and Retention, as a row of links that keeps the project */
export function AnalyticsTabs({ at, project }: { at: (typeof TABS)[number]['to']; project?: string }) {
  return (
    <nav aria-label="Analytics" className="mb-5 flex gap-1 border-b">
      {TABS.map((t) => (
        <Link
          key={t.to}
          to={t.to}
          search={{ project }}
          aria-current={t.to === at ? 'page' : undefined}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            t.to === at
              ? 'border-foreground text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  )
}

/** A share, whole percent from 10% up, one decimal under it */
export const share = (r: number) => (r >= 0.1 || r === 0 ? `${Math.round(r * 100)}%` : `${(r * 100).toFixed(1)}%`)

/** A gap of time, short: 40 s, 12 min, 3.5 h */
export const gap = (ms: number) =>
  ms < 60_000
    ? `${Math.round(ms / 1000)} s`
    : ms < 3_600_000
      ? `${Math.round(ms / 60_000)} min`
      : `${(ms / 3_600_000).toFixed(1)} h`

/** A row of numbers, each in its own tile */
export function Stats({
  stats,
}: {
  stats: { label: string; value: string; change?: number | null; good?: 'up' | 'down' }[]
}) {
  return (
    <dl className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {stats.map((s) => (
        <div key={s.label} className="min-w-0 rounded-xl border p-3">
          <dt className="truncate text-xs text-muted-foreground">{s.label}</dt>
          <dd className="flex items-baseline gap-2">
            <span className="text-lg font-semibold tabular-nums">{s.value}</span>
            {s.change !== undefined && s.change !== null && <Change value={s.change} good={s.good ?? 'up'} />}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** A change against the period before, green the way that's good */
export function Change({ value, good = 'up' }: { value: number | null; good?: 'up' | 'down' }) {
  if (value === null) return <span className="text-xs text-muted-foreground">–</span>
  const pct = Math.round(value * 100)
  const better = good === 'up' ? pct > 0 : pct < 0
  return (
    <span
      className={cn(
        'text-xs tabular-nums',
        pct === 0
          ? 'text-muted-foreground'
          : better
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-red-600 dark:text-red-400',
      )}
    >
      {pct > 0 ? '+' : pct < 0 ? '−' : '±'}
      {Math.abs(pct)}%
    </span>
  )
}

type Step = {
  name: string
  users: number
  ofFirst: number
  ofPrevious: number
  medianTime: number | null
  dropped: number
  droppedWithError: number
  issues: { id: number; title: string; level: string; users: number }[]
}

/**
 * A funnel, a step a row: its bar as a share of the first step's users, then who went on, and of those who stopped
 * there, how many hit an error first, with the issues they hit
 */
export function FunnelSteps({ steps }: { steps: Step[] }) {
  return (
    <ol className="grid grid-cols-1 gap-3">
      {steps.map((s, i) => (
        <li key={`${s.name}-${i}`} className="rounded-xl border p-3 sm:p-4">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="min-w-0 text-sm font-medium wrap-anywhere">
              <span className="mr-2 text-muted-foreground tabular-nums">{i + 1}</span>
              <span className="font-mono">{s.name}</span>
            </p>
            <p className="text-sm text-muted-foreground tabular-nums">
              <span className="font-semibold text-foreground">{count(s.users)}</span> users
              {i > 0 && <> · {share(s.ofPrevious)} of the step before</>}
              {s.medianTime !== null && i > 0 && <> · median {gap(s.medianTime)}</>}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative h-7 min-w-0 flex-1 overflow-hidden rounded-md bg-muted" aria-hidden>
              <div
                className="absolute inset-y-0 left-0 rounded-md"
                style={{ width: `${Math.max(s.ofFirst * 100, 0.5)}%`, background: 'var(--chart-1)' }}
              />
            </div>
            <span className="w-11 shrink-0 text-right text-sm font-medium tabular-nums">{share(s.ofFirst)}</span>
          </div>
          {s.dropped > 0 && (
            <div className="mt-3 grid grid-cols-1 gap-2 text-sm">
              <p className="text-muted-foreground">
                {count(s.dropped)} stopped here.{' '}
                {s.droppedWithError > 0 ? (
                  <span className="text-amber-700 dark:text-amber-400">
                    <IconAlertTriangle className="mr-1 mb-0.5 inline size-4" />
                    {count(s.droppedWithError)} of them, {share(s.droppedWithError / s.dropped)}, hit an error first.
                  </span>
                ) : (
                  'None of them hit an error.'
                )}
              </p>
              {s.issues.length > 0 && (
                <ul className="divide-y rounded-lg border">
                  {s.issues.map((issue) => (
                    <li key={issue.id} className="flex items-center gap-2 px-3 py-2">
                      <Level level={issue.level} />
                      <Link
                        to="/issues/$issueId"
                        params={{ issueId: String(issue.id) }}
                        className="min-w-0 flex-1 truncate font-medium hover:underline"
                      >
                        {issue.title}
                      </Link>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {count(issue.users)} {issue.users === 1 ? 'user' : 'users'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </li>
      ))}
    </ol>
  )
}

/** Weekly cohorts: each row the users who started that week, each cell the share back k weeks later, shaded by it */
export function RetentionGrid({ cohorts }: { cohorts: { start: number; users: number; weeks: number[] }[] }) {
  const prefs = useTimePrefs()
  const width = Math.max(...cohorts.map((c) => c.weeks.length))
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full text-sm tabular-nums">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="px-3 py-2 text-left font-medium whitespace-nowrap">First week</th>
            <th className="px-3 py-2 text-right font-medium">Users</th>
            {Array.from({ length: width }, (_, k) => (
              <th key={k} className="px-1 py-2 text-center font-medium whitespace-nowrap">
                {k === 0 ? 'Week 0' : k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((c) => (
            <tr key={c.start} className="border-b last:border-0">
              <td className="px-3 py-1.5 whitespace-nowrap">{formatTime(c.start, { ...prefs, zone: 'UTC' }, 'day')}</td>
              <td className="px-3 py-1.5 text-right">{count(c.users)}</td>
              {Array.from({ length: width }, (_, k) => {
                const v = c.weeks[k]
                return (
                  <td key={k} className="p-0.5">
                    {v === undefined || c.users === 0 ? (
                      <span className="block h-7" />
                    ) : (
                      <span
                        className="flex h-7 min-w-11 items-center justify-center rounded text-xs"
                        style={{
                          background: `color-mix(in oklab, var(--chart-1) ${Math.round(8 + v * 80)}%, transparent)`,
                        }}
                      >
                        {Math.round(v * 100)}%
                      </span>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
