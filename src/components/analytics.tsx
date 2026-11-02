// Pieces of the analytics pages: their tabs, the filter bar and period, stat tiles, breakdowns, the funnel's bars and
// the retention grid. The filter lives in the URL (`release`, `platform`, `os`, `country`, `prop` as key:value), the
// same on every tab, so moving between tabs keeps it.
import { Link, redirect } from '@tanstack/react-router'
import { IconAlertTriangle, IconX } from '@tabler/icons-react'
import { count, Level } from '@/components/bits'
import { BarList } from '@/components/charts'
import { formatTime, useTimePrefs } from '@/components/time'
import { Button } from '@/components/ui/button'
import { getFirstAnalyticsProject } from '@/fns'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

const TABS = [
  { to: '/analytics', label: 'Overview' },
  { to: '/analytics/insights', label: 'Insights' },
  { to: '/analytics/funnel', label: 'Funnels' },
  { to: '/analytics/retention', label: 'Retention' },
  { to: '/analytics/flows', label: 'Flows' },
  { to: '/analytics/users', label: 'Users' },
] as const
export type Tab = (typeof TABS)[number]['to']

/** A one-project tab's `beforeLoad`: with no project picked, open the first with actions, as `?project=`, so the
 * switcher and breadcrumb name it rather than the page choosing out of sight */
export async function openAnalyticsProject(to: Exclude<Tab, '/analytics'>, search: { project?: string }) {
  if (search.project) return
  const project = await getFirstAnalyticsProject()
  if (project) throw redirect({ to, search: { ...search, project } as never, replace: true })
}

/** The tabs, as links that keep the project and the filter */
export function AnalyticsTabs({ at, search }: { at: Tab; search: FilterSearch & { project?: string } }) {
  const keep = { project: search.project, ...pickFilter(search) }
  return (
    <nav
      aria-label="Analytics"
      className="mb-4 flex gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--border)] [scrollbar-width:none]"
    >
      {TABS.map((t) => (
        <Link
          key={t.to}
          to={t.to}
          search={keep}
          aria-current={t.to === at ? 'page' : undefined}
          className={cn(
            'shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
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

export type FilterSearch = { release?: string; platform?: string; os?: string; country?: string; prop?: string }
const FILTER_NAMES = ['platform', 'os', 'country', 'release'] as const
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

/** The filter's part of a page's search, checked */
export const readFilter = (s: Record<string, unknown>): FilterSearch => ({
  release: str(s.release),
  platform: str(s.platform),
  os: str(s.os),
  country: str(s.country),
  prop: str(s.prop),
})
const pickFilter = (s: FilterSearch): FilterSearch => readFilter(s as Record<string, unknown>)

/** The filter as the server functions take it: `prop` split at its first colon */
export function toFilter(s: FilterSearch) {
  const at = s.prop?.indexOf(':') ?? -1
  return {
    release: s.release,
    platform: s.platform,
    os: s.os,
    country: s.country,
    prop: s.prop && at > 0 ? { key: s.prop.slice(0, at), value: s.prop.slice(at + 1) } : undefined,
  }
}

const regions = new Intl.DisplayNames(['en'], { type: 'region' })
/** A country's name from its code, the code when it isn't one */
export function countryName(code: string) {
  if (!/^[A-Z]{2}$/.test(code)) return code
  try {
    return regions.of(code) ?? code
  } catch {
    return code
  }
}
/** A breakdown's value as it reads: none as such, a country by name */
export const valueLabel = (field: string, v: string) =>
  !v || v === '(none)' ? 'None' : field === 'country' ? countryName(v) : v

const FIELD_LABELS: Record<string, string> = {
  platform: 'Platform',
  os: 'OS',
  country: 'Country',
  release: 'Release',
  device: 'Device',
  browser: 'Browser',
  environment: 'Environment',
}
const ANY_LABEL: Record<string, string> = {
  platform: 'Any platform',
  os: 'Any OS',
  country: 'Any country',
  release: 'Any release',
}

type Options = {
  columns: Record<(typeof FILTER_NAMES)[number], string[]>
  properties: { key: string; values: string[] }[]
}
const ANY = '__any'

/**
 * The filter bar: platform, OS, country and release, each a select of what the last 30 days had, then a property and
 * one of its values. Clear filters drops them all
 */
export function FilterBar({
  options,
  search,
  onChange,
}: {
  options: Options
  search: FilterSearch
  onChange: (next: FilterSearch) => void
}) {
  const at = search.prop?.indexOf(':') ?? -1
  const key = search.prop && at > 0 ? search.prop.slice(0, at) : undefined
  const value = search.prop && at > 0 ? search.prop.slice(at + 1) : undefined
  const values = options.properties.find((p) => p.key === key)?.values ?? []
  const active = FILTER_NAMES.some((n) => search[n]) || !!search.prop
  const set = (patch: FilterSearch) => onChange({ ...pickFilter(search), ...patch })
  const picked = 'border-foreground/40'
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
      {FILTER_NAMES.map((n) =>
        options.columns[n].length || search[n] ? (
          <Select key={n} value={search[n] ?? ANY} onValueChange={(v) => set({ [n]: v === ANY ? undefined : v })}>
            <SelectTrigger className={cn('h-10 max-w-48 min-w-0', search[n] && picked)} aria-label={FIELD_LABELS[n]}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{ANY_LABEL[n]}</SelectItem>
              {[...new Set([...(search[n] ? [search[n]] : []), ...options.columns[n]])].map((v) => (
                <SelectItem key={v} value={v}>
                  {valueLabel(n, v)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null,
      )}
      {options.properties.length > 0 && (
        <Select
          value={key ?? ANY}
          onValueChange={(k) =>
            set({
              prop: k === ANY ? undefined : `${k}:${options.properties.find((p) => p.key === k)?.values[0] ?? ''}`,
            })
          }
        >
          <SelectTrigger className={cn('h-10 max-w-48 min-w-0', key && picked)} aria-label="Property">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any property</SelectItem>
            {options.properties.map((p) => (
              <SelectItem key={p.key} value={p.key} className="font-mono text-xs">
                {p.key}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {key && (
        <Select value={value ?? ''} onValueChange={(v) => set({ prop: `${key}:${v}` })}>
          <SelectTrigger className={cn('h-10 max-w-48 min-w-0', picked)} aria-label={`Value of ${key}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[...new Set([value ?? '', ...values])].filter(Boolean).map((v) => (
              <SelectItem key={v} value={v} className="font-mono text-xs">
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {active && (
        <Button
          variant="ghost"
          className="h-10"
          onClick={() =>
            onChange({ release: undefined, platform: undefined, os: undefined, country: undefined, prop: undefined })
          }
        >
          <IconX />
          Clear filters
        </Button>
      )}
    </div>
  )
}

const PERIODS = { 1: 'Last 24 hours', 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days' } as Record<
  number,
  string
>

/** The period an analytics page reads */
export function PeriodSelect({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  return (
    <Select value={String(days)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="h-10 w-40" aria-label="Period">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {Object.entries(PERIODS).map(([v, label]) => (
          <SelectItem key={v} value={v}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** The period from the URL: 30 days unless it says 1, 7 or 90 */
export const readDays = (v: unknown) => ([1, 7, 90].includes(Number(v)) ? Number(v) : undefined)

/** A share, whole percent from 10% up, one decimal under it */
export const share = (r: number) => (r >= 0.1 || r === 0 ? `${Math.round(r * 100)}%` : `${(r * 100).toFixed(1)}%`)

/** A gap of time, short: 40 s, 12 min, 3.5 h */
export const gap = (ms: number) =>
  ms < 60_000
    ? `${Math.round(ms / 1000)} s`
    : ms < 3_600_000
      ? `${Math.round(ms / 60_000)} min`
      : `${(ms / 3_600_000).toFixed(1)} h`

/** A row of numbers, each in its own tile, with what it means under it when `hint` says */
export function Stats({
  stats,
}: {
  stats: { label: string; value: string; change?: number | null; good?: 'up' | 'down'; hint?: string }[]
}) {
  return (
    <dl className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {stats.map((s) => (
        <div key={s.label} className="min-w-0 rounded-xl border p-3">
          <dt className="truncate text-xs text-muted-foreground">{s.label}</dt>
          <dd className="flex items-baseline gap-2">
            <span className="text-lg font-semibold tabular-nums">{s.value}</span>
            {s.change !== undefined && s.change !== null && <Change value={s.change} good={s.good ?? 'up'} />}
          </dd>
          {s.hint && <dd className="mt-0.5 truncate text-xs text-muted-foreground">{s.hint}</dd>}
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

/** A breakdown in a card: its title, then its values as bars of their share of `total`; + filters by one */
export function Breakdown({
  title,
  field,
  items,
  total,
  unit = 'users',
  onPick,
}: {
  title: string
  field: string
  items: { value: string; count: number }[]
  total: number
  unit?: string
  onPick?: (value: string) => void
}) {
  const label = (v: string) => valueLabel(field, v)
  return (
    <section className="min-w-0 rounded-xl border p-3">
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      {items.length ? (
        <BarList
          items={items.map((i) => ({ value: label(i.value), count: i.count }))}
          total={total}
          format={(n) => `${count(n)} ${unit} · ${share(total ? n / total : 0)}`}
          onInclude={
            onPick
              ? (shown) => {
                  const v = items.find((i) => label(i.value) === shown)?.value
                  if (v && v !== '(none)') onPick(v)
                }
              : undefined
          }
        />
      ) : (
        <p className="text-sm text-muted-foreground">Nothing in this period.</p>
      )}
    </section>
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
                <IssueRows issues={s.issues.map((i) => ({ ...i, count: i.users, unit: 'user' }))} />
              )}
            </div>
          )}
        </li>
      ))}
    </ol>
  )
}

/** Issues as rows: their level, title linking to the issue, and a count */
export function IssueRows({
  issues,
}: {
  issues: { id: number; title: string; level: string; count: number; unit: string }[]
}) {
  return (
    <ul className="divide-y rounded-lg border text-sm">
      {issues.map((issue) => (
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
            {count(issue.count)} {issue.count === 1 ? issue.unit : `${issue.unit}s`}
          </span>
        </li>
      ))}
    </ul>
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
              <td className="px-3 py-1.5 whitespace-nowrap">{formatTime(c.start, prefs, 'day')}</td>
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

/** An action picker: every action name, plus `value` when it isn't among them; `any` for no action in particular */
export function ActionSelect({
  names,
  value,
  onChange,
  label,
  className,
  any,
}: {
  names: string[]
  value?: string
  onChange: (v: string | undefined) => void
  label: string
  className?: string
  any?: string
}) {
  const list = [...new Set([...(value ? [value] : []), ...names])]
  return (
    <Select value={value ?? ANY} onValueChange={(v) => onChange(v === ANY ? undefined : v)}>
      <SelectTrigger className={cn('h-10 min-w-0 font-mono text-xs', className)} aria-label={label}>
        <SelectValue placeholder="Pick an action" />
      </SelectTrigger>
      <SelectContent>
        {any && (
          <SelectItem value={ANY} className="font-sans text-sm">
            {any}
          </SelectItem>
        )}
        {list.map((n) => (
          <SelectItem key={n} value={n} className="font-mono text-xs">
            {n}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

const BY = {
  platform: 'By platform',
  os: 'By OS',
  country: 'By country',
  release: 'By release',
  device: 'By device',
  browser: 'By browser',
}

/** A breakdown picker: none, the columns, then the properties seen */
export function BreakdownSelect({
  value,
  onChange,
  properties,
  label,
  none = 'No breakdown',
}: {
  value?: string
  onChange: (v: string | undefined) => void
  properties: { key: string }[]
  label: string
  none?: string
}) {
  return (
    <Select value={value ?? ANY} onValueChange={(v) => onChange(v === ANY ? undefined : v)}>
      <SelectTrigger className="h-10 w-44 min-w-0" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{none}</SelectItem>
        {Object.entries(BY).map(([c, text]) => (
          <SelectItem key={c} value={c}>
            {text}
          </SelectItem>
        ))}
        {properties.map((p) => (
          <SelectItem key={p.key} value={`prop:${p.key}`}>
            By <span className="font-mono text-xs">{p.key}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
