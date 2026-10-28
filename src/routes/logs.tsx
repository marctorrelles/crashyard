import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
  IconBell,
  IconChartLine,
  IconChevronRight,
  IconDots,
  IconDownload,
  IconLayoutDashboard,
  IconLogs,
  IconMinus,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconSearch,
  IconX,
} from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { count } from '@/components/bits'
import { BarList, LEVEL_COLORS, PALETTE, type Series, TimeChart } from '@/components/charts'
import { SavedSearches, SearchBar } from '@/components/search-bar'
import { Time } from '@/components/time'
import { Empty, PageHeader, Shell, useProjects } from '@/components/shell'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ValueMenu } from '@/components/value-menu'
import { GroupBy as FieldSelect, WidgetView } from '@/components/widget'
import { change } from '@/data/charts'
import { GROUP_COLUMNS, MAX_SPAN } from '@/data/logs'
import { type Aggregate, aggregateError, aggregatesOf, MAX_QUERIES, type Widget } from '@/data/widgets'
import {
  addWidget,
  getDashboards,
  getLogChart,
  getLogGroups,
  getLogMaths,
  getLogs,
  getSavedSearches,
  getSuggestions,
} from '@/fns'
import { cn } from '@/lib/utils'
import { addValue, isSearchableKey, logAttributeKey } from '@/search/query'

const RANGES = { '1h': 'Last hour', '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' } as const
type Range = keyof typeof RANGES
// `from` and `to` (ms, a drag on the chart) stand in for `range` while they're set; `range` stays for Reset. `fn` is
// the charts' functions, comma-separated (count when unset), `groupBy` up to 2 fields, comma-separated
type Search = {
  project?: string
  query?: string
  range?: Range
  from?: number
  to?: number
  groupBy?: string
  fn?: string
}
const listOf = (v?: string) => (v ? v.split(',') : [])
/** The charts' functions: up to 3 a logs widget can compute, count when none */
const functionsOf = (fn?: string): Aggregate[] => {
  const list = listOf(fn).filter((f) => !aggregateError('logs', f)) as Aggregate[]
  return list.length ? list.slice(0, MAX_QUERIES) : ['count']
}
// The first chart is the logs page's own (levels or one group's, the span before, zoom) for a count by one field or none
const ownChart = (fns: Aggregate[], groupBy: string[]) => fns[0] === 'count' && groupBy.length <= 1

const whole = (v: unknown) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : undefined)

export const Route = createFileRoute('/logs')({
  validateSearch: (s: Record<string, unknown>): Search => {
    const from = whole(s.from)
    const to = whole(s.to)
    // An exact span counts only whole (both ends, in order, 90 days at most); else the range does
    const exact = from !== undefined && to !== undefined && from < to && to - from <= MAX_SPAN
    return {
      project: typeof s.project === 'string' && s.project ? s.project : undefined,
      // An empty query is kept: it's "everything", not the pinned search
      query: typeof s.query === 'string' ? s.query : undefined,
      range: typeof s.range === 'string' && s.range in RANGES ? (s.range as Range) : undefined,
      from: exact ? from : undefined,
      to: exact ? to : undefined,
      groupBy:
        typeof s.groupBy === 'string' && /^[\w.-]{1,60}(,[\w.-]{1,60})?$/.test(s.groupBy) ? s.groupBy : undefined,
      fn: typeof s.fn === 'string' && s.fn && s.fn !== 'count' ? functionsOf(s.fn).join(',') : undefined,
    }
  },
  loaderDeps: ({ search }) => search,
  // With a group-by, the chart is its groups (and the table over the list); else logs by level. Other functions, and
  // two group-bys, are read as a logs widget is (`getLogMaths`)
  loader: async ({ deps }) => {
    // With no query in the URL, the viewer's pinned search opens
    const saved = await getSavedSearches({ data: { page: 'logs' } })
    const opening = saved.find((s) => s.pinned)?.query ?? ''
    const params = paramsOf({ ...deps, query: deps.query ?? opening })
    const fns = functionsOf(deps.fn)
    const groupBy = listOf(deps.groupBy)
    const own = ownChart(fns, groupBy)
    const others = own ? fns.slice(1) : fns
    const table = groupBy.length > 0 && !(groupBy.length === 1 && fns.length === 1 && own)
    const [list, chart, groups, maths] = await Promise.all([
      getLogs({ data: params }),
      own && !groupBy.length ? getLogChart({ data: params }) : undefined,
      own && groupBy.length ? getLogGroups({ data: { ...params, groupBy: groupBy[0] } }) : undefined,
      others.length || table
        ? getLogMaths({ data: { ...params, functions: others, groupBy, table: table ? fns : [] } })
        : undefined,
    ])
    return { ...list, chart, groups, charts: maths?.charts ?? [], table: maths?.table, saved, opening }
  },
  head: () => ({ meta: [{ title: 'Logs · crashyard' }] }),
  component: Logs,
})

type Params = { project?: string; query: string } & ({ range: Range } | { from: number; to: number })
const paramsOf = (s: Search): Params => ({
  project: s.project,
  query: s.query ?? '',
  ...(s.from !== undefined && s.to !== undefined ? { from: s.from, to: s.to } : { range: s.range ?? '24h' }),
})

type Log = Awaited<ReturnType<typeof getLogs>>['logs'][number]
type Pick = (key: string, value: string, negate: boolean) => void

const LEVEL_STYLE: Record<string, string> = {
  fatal: 'bg-red-600 text-white',
  error: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  warn: 'bg-amber-400/20 text-amber-800 dark:text-amber-300',
  info: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  debug: 'bg-muted text-muted-foreground',
  trace: 'bg-muted text-muted-foreground',
}

// A range's length, for "the … before"
const PERIODS: Record<Range, string> = { '1h': 'hour', '24h': 'day', '7d': 'week', '30d': '30 days' }
const INTERVALS = { '1m': 'minute', '5m': '5 minutes', '1h': 'hour', '1d': 'day' } as const

/** A span as days, hours and minutes: `2 h 30 min` */
function spanText(ms: number) {
  const minutes = Math.round(ms / 6e4)
  const [d, h, m] = [Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60), minutes % 60]
  return [d && `${d} d`, h && `${h} h`, m && `${m} min`].filter(Boolean).join(' ') || '<1 min'
}

function Logs() {
  const search = Route.useSearch()
  const data = Route.useLoaderData()
  const name = useProjects().find((p) => p.slug === search.project)?.name ?? search.project
  const navigate = useNavigate({ from: Route.fullPath })
  const query = search.query ?? data.opening
  // An empty search stays in the URL while a pinned one would open instead
  const go = (change: Partial<Search>) => void navigate({ search: (s) => ({ ...s, ...change }) })
  const searchFor = (q: string) => q || (data.opening ? '' : undefined)
  const [live, setLive] = useState(false)
  const [adding, setAdding] = useState<Widget | null>(null)
  const params = paramsOf({ ...search, query })
  const custom = 'from' in params
  const pick: Pick = (key, value, negate) => go({ query: searchFor(addValue(query, key, value, negate)) })
  // Keys whose values all differ (an id, a duration) say nothing as a facet
  const facets = new Map(
    [...Map.groupBy(data.facets, (f) => f.key)].filter(([, values]) => values[0].n > 1).slice(0, 10),
  )
  // Every log has a level, so the levels' counts add up to the sample the facets count over
  const sampled = data.facets.filter((f) => f.key === 'level').reduce((sum, f) => sum + f.n, 0)
  const fns = functionsOf(search.fn)
  const groupBy = listOf(search.groupBy)
  const own = ownChart(fns, groupBy)
  const chart = own ? chartOf(data, groupBy[0]) : undefined
  const setFns = (list: string[]) => go({ fn: list.length === 1 && list[0] === 'count' ? undefined : list.join(',') })
  const setGroups = (list: (string | undefined)[]) => {
    const g = list.filter((x): x is string => !!x)
    go({ groupBy: g.length ? [...new Set(g)].join(',') : undefined })
  }
  // A chart as a dashboard widget: its function over the search, by the same fields
  const widgetOf = (fn: Aggregate): Widget => ({
    id: [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join(''),
    title: fn === 'count' ? 'Logs' : fn,
    dataset: 'logs',
    display: fn === 'count' ? 'bar' : 'line',
    queries: [{ query, aggregate: fn }],
    ...(groupBy.length ? { groupBy } : {}),
    width: 2,
  })
  const menu = (fn: Aggregate, i: number) => (
    <ChartMenu
      fn={fn}
      onAdd={() => setAdding(widgetOf(fn))}
      onAlert={
        fn === 'count'
          ? () =>
              void navigate({
                to: '/notifications',
                search: { metric: 'log_count', query: query || undefined, project: search.project },
              })
          : undefined
      }
      onRemove={fns.length > 1 ? () => setFns(fns.filter((_, j) => j !== i)) : undefined}
    />
  )
  const exportUrl = (format: 'csv' | 'jsonl') => {
    const u = new URLSearchParams({ format, query })
    if (search.project) u.set('project', search.project)
    if ('from' in params) {
      u.set('from', String(params.from))
      u.set('to', String(params.to))
    } else u.set('range', params.range)
    return `/logs/export?${u}`
  }
  return (
    <Shell wide crumbs={name ? [<Link to="/logs">Logs</Link>, name] : ['Logs']}>
      <PageHeader title="Logs">{name}</PageHeader>
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="min-w-60 flex-1">
          <SearchBar
            scope="logs"
            query={query}
            project={search.project}
            range={search.range}
            placeholder='level:error song:42 "export failed"'
            onSearch={(q) => go({ query: searchFor(q) })}
          />
        </div>
        <SavedSearches page="logs" query={query} searches={data.saved} onPick={(q) => go({ query: searchFor(q) })} />
        <Select
          value={custom ? 'custom' : (search.range ?? '24h')}
          onValueChange={(v) => go({ range: v === '24h' ? undefined : (v as Range), from: undefined, to: undefined })}
        >
          <SelectTrigger className="w-40" aria-label="Time range">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {custom && (
              <SelectItem value="custom" disabled>
                Custom, {spanText(params.to - params.from)}
              </SelectItem>
            )}
            {Object.entries(RANGES).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {custom && (
          <Button variant="secondary" onClick={() => go({ from: undefined, to: undefined })}>
            <IconX data-icon="inline-start" />
            Reset
          </Button>
        )}
        <GroupBy
          prefix="Group by"
          value={groupBy[0]}
          project={search.project}
          range={search.range}
          onChange={(g) => setGroups(g ? [g, groupBy[1]] : [])}
        />
        {groupBy[0] && (
          <GroupBy
            prefix="Then by"
            value={groupBy[1]}
            exclude={groupBy[0]}
            project={search.project}
            range={search.range}
            onChange={(g) => setGroups([groupBy[0], g])}
          />
        )}
        <AddChart
          disabled={fns.length >= MAX_QUERIES}
          project={search.project}
          range={search.range}
          onAdd={(fn) => setFns([...fns, fn])}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" aria-label="Export" title="Export">
              <IconDownload data-icon="inline-start" />
              Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <a href={exportUrl('csv')} download>
                Export CSV
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={exportUrl('jsonl')} download>
                Export JSON Lines
              </a>
            </DropdownMenuItem>
            <p className="px-2 py-1.5 text-xs text-muted-foreground">The newest 10,000 logs of this search.</p>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant={live ? 'default' : 'outline'}
          onClick={() => setLive(!live)}
          aria-pressed={live}
          disabled={custom}
          title={custom ? 'Reset the time range to follow new logs live' : undefined}
        >
          {live ? <IconPlayerPause data-icon="inline-start" /> : <IconPlayerPlay data-icon="inline-start" />}
          Live
        </Button>
      </div>

      {chart && (
        <section className="mb-3 rounded-xl border p-3 pb-1" aria-label="Logs over time">
          <div className="mb-2 flex items-start justify-between gap-2">
            <p className="text-sm">
              <span className="font-medium tabular-nums">{count(chart.total)}</span>{' '}
              <span className="text-muted-foreground">
                logs{groupBy[0] && !Object.hasOwn(GROUP_COLUMNS, groupBy[0]) && <> with {groupBy[0]}</>}, per{' '}
                {INTERVALS[chart.interval]}
                {groupBy[0] && Object.hasOwn(GROUP_COLUMNS, groupBy[0]) && <> by {groupBy[0]}</>}
                {chart.before > 0 && (
                  <span className="max-sm:hidden">
                    , {count(chart.before)} in the{' '}
                    {'range' in params ? PERIODS[params.range] : spanText(chart.to - chart.from)} before
                  </span>
                )}
                <span className="pointer-coarse:hidden"> · drag across the chart to zoom in</span>
              </span>
            </p>
            {menu('count', 0)}
          </div>
          <TimeChart
            x={chart.x}
            series={chart.series}
            previous={chart.previous}
            height={140}
            onZoom={(from, to) => go({ from: Math.max(from, chart.from), to: Math.min(to, chart.to) })}
          />
        </section>
      )}

      {data.charts.length > 0 && (
        <div className={cn('mb-3 grid gap-3', data.charts.length > 1 && 'md:grid-cols-2')}>
          {data.charts.map((d, i) => {
            const at = own ? i + 1 : i
            const fn = fns[at]
            if (!fn) return null
            return (
              <section
                key={`${fn}-${at}`}
                className="min-w-0 rounded-xl border p-3 pb-1"
                aria-label={`${fn} over time`}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-sm">
                    <IconChartLine className="size-4 text-muted-foreground" />
                    <span className="font-mono">{fn}</span>
                    {groupBy.length > 0 && <span className="text-muted-foreground">by {groupBy.join(' and ')}</span>}
                  </p>
                  {menu(fn, at)}
                </div>
                <WidgetView
                  widget={widgetOf(fn)}
                  data={d}
                  range={search.range ?? '24h'}
                  project={search.project}
                  height={140}
                />
              </section>
            )
          })}
        </div>
      )}

      {data.table ? (
        <section className="mb-3 rounded-xl border p-3" aria-label={`Logs by ${groupBy.join(' and ')}`}>
          <WidgetView
            widget={{ ...widgetOf(fns[0]), display: 'table', queries: fns.map((aggregate) => ({ query, aggregate })) }}
            data={data.table}
            range={search.range ?? '24h'}
            project={search.project}
          />
        </section>
      ) : (
        data.groups &&
        groupBy[0] && <Groups groups={data.groups.groups} total={data.groups.total} field={groupBy[0]} onPick={pick} />
      )}

      <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        {facets.size > 0 && (
          <>
            <aside className="max-lg:hidden">
              <Facets facets={facets} total={sampled} onPick={pick} />
            </aside>
            <details className="rounded-xl border lg:hidden">
              <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium">Filters</summary>
              <div className="p-3 pt-0">
                <Facets facets={facets} total={sampled} onPick={pick} />
              </div>
            </details>
          </>
        )}
        <div className="min-w-0 lg:col-start-2">
          <LogStream
            key={JSON.stringify(params)}
            initial={data}
            params={params}
            live={live && !custom}
            showProject={!search.project}
            onPick={pick}
          />
        </div>
      </div>
      {adding && <AddToDashboard widget={adding} onClose={() => setAdding(null)} />}
    </Shell>
  )
}

/** A chart's menu: add it to a dashboard, alert on it (counts), remove it */
function ChartMenu({
  fn,
  onAdd,
  onAlert,
  onRemove,
}: {
  fn: string
  onAdd: () => void
  onAlert?: () => void
  onRemove?: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="max-sm:size-10" aria-label={`More for ${fn}`}>
          <IconDots />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onAdd}>
          <IconLayoutDashboard />
          Add to dashboard
        </DropdownMenuItem>
        {onAlert && (
          <DropdownMenuItem onSelect={onAlert}>
            <IconBell />
            Create metric alert
          </DropdownMenuItem>
        )}
        {onRemove && (
          <DropdownMenuItem onSelect={onRemove}>
            <IconX />
            Remove chart
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const FUNCTIONS = aggregatesOf('logs')
const FUNCTION_NAMES: Record<string, string> = {
  count: 'Count',
  avg: 'Average',
  sum: 'Sum',
  min: 'Minimum',
  max: 'Maximum',
}

/** "Add chart": a function, and for all but count a numeric attribute it's of */
function AddChart({
  disabled,
  project,
  range,
  onAdd,
}: {
  disabled: boolean
  project?: string
  range?: Range
  onAdd: (fn: Aggregate) => void
}) {
  const [open, setOpen] = useState(false)
  const [fn, setFn] = useState('p95')
  const [field, setField] = useState<string | undefined>('duration')
  const aggregate = (fn === 'count' ? 'count' : `${fn}(${field ?? ''})`) as Aggregate
  const error = aggregateError('logs', aggregate)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          title={disabled ? 'Remove a chart first: the page shows 3 at most' : undefined}
        >
          <IconPlus data-icon="inline-start" />
          Add chart
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (error) return
            onAdd(aggregate)
            setOpen(false)
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="chart-fn">Function</Label>
            <Select value={fn} onValueChange={setFn}>
              <SelectTrigger id="chart-fn" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[...FUNCTIONS.plain, ...FUNCTIONS.fns].map((f) => (
                  <SelectItem key={f} value={f}>
                    {FUNCTION_NAMES[f] ?? f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {fn !== 'count' && (
            <div className="grid gap-2">
              <Label htmlFor="chart-field">Of the attribute</Label>
              <FieldSelect
                id="chart-field"
                dataset="logs"
                value={field}
                project={project}
                range={range}
                none="Pick an attribute"
                attributesOnly
                onChange={setField}
              />
              <Input
                aria-label="Attribute name"
                value={field ?? ''}
                placeholder="duration"
                className="font-mono"
                onChange={(e) => setField(e.target.value.trim() || undefined)}
              />
              <p className="text-xs text-muted-foreground">Logs where it isn’t a number are left out.</p>
            </div>
          )}
          <Button type="submit" disabled={!!error}>
            Add chart
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}

/** "Add to dashboard": the chart as a widget at the end of a dashboard picked from the list */
function AddToDashboard({ widget, onClose }: { widget: Widget; onClose: () => void }) {
  const [list, setList] = useState<{ id: number; name: string }[] | null>(null)
  const [id, setId] = useState<string>('')
  const [title, setTitle] = useState(widget.title)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void getDashboards().then((d) => {
      if (!live) return
      setList(d.dashboards)
      setId(d.dashboards[0] ? String(d.dashboards[0].id) : '')
    })
    return () => {
      live = false
    }
  }, [])
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            try {
              await addWidget({ data: { id: Number(id), widget: { ...widget, title: title.trim() || widget.title } } })
              toast.success(`Added to ${list?.find((d) => String(d.id) === id)?.name ?? 'the dashboard'}`)
              onClose()
            } catch (error) {
              toast.error(error instanceof Error ? error.message : 'The widget couldn’t be added')
              setBusy(false)
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Add to dashboard</DialogTitle>
            <DialogDescription>The chart joins the end of the dashboard, with this search.</DialogDescription>
          </DialogHeader>
          {list !== null && list.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No dashboards yet.{' '}
              <Link to="/dashboards" className="underline">
                Create one
              </Link>{' '}
              first.
            </p>
          ) : (
            <>
              <div className="grid gap-2">
                <Label htmlFor="add-dashboard">Dashboard</Label>
                <Select value={id} onValueChange={setId} disabled={list === null}>
                  <SelectTrigger id="add-dashboard" className="w-full">
                    <SelectValue placeholder="Loading…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(list ?? []).map((d) => (
                      <SelectItem key={d.id} value={String(d.id)}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="add-title">Title</Label>
                <Input
                  id="add-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={80}
                  required
                />
              </div>
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !id}>
              Add to dashboard
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// What a group's value reads as: a missing release or environment is none, the rest beyond the top is other
const groupLabel = (value: string | null) => (value === null ? 'Other' : value === '' ? 'None' : value)

/** The chart's view: logs by level (with the span before as a dashed line), or by the group-by's groups */
function chartOf(
  data: { chart?: Awaited<ReturnType<typeof getLogChart>>; groups?: Awaited<ReturnType<typeof getLogGroups>> },
  groupBy?: string,
) {
  if (data.groups) {
    const g = data.groups
    return {
      ...g,
      before: g.groups.reduce((a, x) => a + x.previous, 0),
      previous: undefined,
      series: g.series.map((s, i): Series => ({
        key: `g${i}`,
        label: groupLabel(s.value),
        values: s.counts,
        color:
          s.value === null
            ? 'var(--muted-foreground)'
            : groupBy === 'level' && LEVEL_COLORS[s.value]
              ? LEVEL_COLORS[s.value]
              : PALETTE[i % PALETTE.length],
      })),
    }
  }
  const c = data.chart!
  return {
    ...c,
    total: c.levels.reduce((sum, s) => sum + s.counts.reduce((a, b) => a + b, 0), 0),
    before: c.previous.reduce((a, b) => a + b, 0),
    series: c.levels.map((s): Series => ({ key: s.level, label: s.level, values: s.counts })),
  }
}

/** The group-by: a log column, or an attribute (the keys stored, asked for when the menu first opens) */
function GroupBy({
  prefix,
  value,
  exclude,
  project,
  range,
  onChange,
}: {
  prefix: string
  value?: string
  exclude?: string
  project?: string
  range?: Range
  onChange: (groupBy: string | undefined) => void
}) {
  const [keys, setKeys] = useState<string[]>([])
  const [asked, setAsked] = useState(false)
  const load = (open: boolean) => {
    if (!open || asked) return
    setAsked(true)
    void getSuggestions({ data: { scope: 'logs', project, range } }).then((r) => {
      if ('keys' in r) setKeys(r.keys.filter((k) => k.kind === 'tag').map((k) => k.key))
    })
  }
  const columns = Object.keys(GROUP_COLUMNS).filter((c) => c !== exclude)
  const attributes = [...new Set([...(value && !columns.includes(value) ? [value] : []), ...keys])].filter(
    (k) => k !== exclude,
  )
  return (
    <Select value={value ?? 'none'} onValueChange={(v) => onChange(v === 'none' ? undefined : v)} onOpenChange={load}>
      <SelectTrigger className="w-48" aria-label={prefix}>
        <span className="flex min-w-0 gap-1.5">
          <span className="text-muted-foreground">{prefix}</span>
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent align="end">
        <SelectGroup>
          <SelectItem value="none">None</SelectItem>
          {columns.map((c) => (
            <SelectItem key={c} value={c}>
              {c}
            </SelectItem>
          ))}
        </SelectGroup>
        {attributes.length > 0 && (
          <SelectGroup>
            <SelectLabel>Attributes</SelectLabel>
            {attributes.map((k) => (
              <SelectItem key={k} value={k} className="font-mono">
                {k}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  )
}

/** The groups as a table: each value's logs, the change since the span before, its share; click to show only it */
function Groups({
  groups,
  total,
  field,
  onPick,
}: {
  groups: { value: string | null; count: number; previous: number }[]
  total: number
  field: string
  onPick: Pick
}) {
  if (!groups.length) return null
  // Hovering shows + and −, as in the facets; always there on touch
  const action = 'max-sm:size-10 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 focus-visible:opacity-100'
  return (
    <section className="mb-3 overflow-hidden rounded-xl border" aria-label={`Logs by ${field}`}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="font-mono">{field}</TableHead>
            <TableHead className="text-right">Logs</TableHead>
            <TableHead className="text-right">Change</TableHead>
            <TableHead className="w-1/4 max-sm:hidden">Share</TableHead>
            <TableHead className="w-0">
              <span className="sr-only">Show only or exclude</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="tabular-nums">
          {groups.map((g) => {
            const filterable = g.value !== null && g.value !== '' && isSearchableKey(field)
            const diff = change(g.count, g.previous)
            const share = total > 0 ? g.count / total : 0
            return (
              <TableRow key={g.value ?? '\u0000'} className="group">
                <TableCell className="max-w-0 font-mono text-xs">
                  {filterable ? (
                    <button
                      type="button"
                      className="block max-w-full truncate text-left hover:underline max-sm:min-h-10"
                      title={`Show only ${g.value}`}
                      onClick={() => onPick(field, g.value!, false)}
                    >
                      {g.value}
                    </button>
                  ) : (
                    <span className="text-muted-foreground">{groupLabel(g.value)}</span>
                  )}
                </TableCell>
                <TableCell className="text-right">{count(g.count)}</TableCell>
                <TableCell
                  className={cn(
                    'text-right',
                    diff === null || Math.abs(diff) < 0.005
                      ? 'text-muted-foreground'
                      : diff > 0
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-emerald-600 dark:text-emerald-400',
                  )}
                >
                  {diff === null
                    ? 'new'
                    : `${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${Math.round(Math.abs(diff) * 100)}%`}
                </TableCell>
                <TableCell className="max-sm:hidden">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-foreground/60" style={{ width: `${share * 100}%` }} />
                    </div>
                    <span className="w-9 text-right text-xs text-muted-foreground">
                      {share > 0 && share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="py-0">
                  {filterable && (
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className={action}
                        aria-label={`Show only ${g.value}`}
                        title="Show only this"
                        onClick={() => onPick(field, g.value!, false)}
                      >
                        <IconPlus />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className={action}
                        aria-label={`Exclude ${g.value}`}
                        title="Exclude this"
                        onClick={() => onPick(field, g.value!, true)}
                      >
                        <IconMinus />
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </section>
  )
}

/** Each key's top values in the sample, as bars of their share; + and − include or exclude one */
function Facets({
  facets,
  total,
  onPick,
}: {
  facets: Map<string, { key: string; value: string; n: number }[]>
  total: number
  onPick: Pick
}) {
  return (
    <div className="grid gap-4">
      {[...facets].map(([key, values]) => (
        <div key={key}>
          <h3 className="mb-1 truncate font-mono text-xs text-muted-foreground">{key}</h3>
          <BarList
            items={values.map((v) => ({ value: v.value, count: v.n }))}
            total={total}
            onInclude={isSearchableKey(key) ? (v) => onPick(key, v, false) : undefined}
            onExclude={isSearchableKey(key) ? (v) => onPick(key, v, true) : undefined}
          />
        </div>
      ))}
    </div>
  )
}

/** The loader's page, plus what the live tail and "Older" add; a new search mounts a new one */
function LogStream({
  initial,
  params,
  live,
  showProject,
  onPick,
}: {
  initial: { logs: Log[]; more: boolean }
  params: Params
  live: boolean
  showProject: boolean
  onPick: Pick
}) {
  const [logs, setLogs] = useState(initial.logs)
  const [more, setMore] = useState(initial.more)
  const [loadingOlder, setLoadingOlder] = useState(false)
  // The newest id shown: the live tail asks for what arrived after it, whatever the logs' own times
  const newest = useRef(Math.max(0, ...initial.logs.map((l) => l.id)))
  // Logs not shown yet, newest first: none twice, whichever request brought them
  const add = (fresh: Log[], at: 'top' | 'bottom') =>
    setLogs((l) => {
      const shown = new Set(l.map((x) => x.id))
      const unseen = fresh.filter((x) => !shown.has(x.id))
      return at === 'top' ? [...unseen, ...l].slice(0, 1000) : [...l, ...unseen]
    })
  useEffect(() => {
    if (!live) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    // One request at a time: the next waits for the last, sooner while a burst is being read
    const poll = async () => {
      const fresh = await getLogs({ data: { ...params, after: { timestamp: 0, id: newest.current } } }).catch(
        () => null,
      )
      if (stopped) return
      if (fresh?.logs.length) {
        newest.current = Math.max(newest.current, ...fresh.logs.map((l) => l.id))
        add(fresh.logs, 'top')
      }
      timer = setTimeout(poll, fresh?.more ? 0 : 2000)
    }
    timer = setTimeout(poll, 2000)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [live, params])
  return (
    <>
      {logs.length === 0 ? (
        params.query || 'from' in params ? (
          <Empty icon={IconSearch} title="No logs match">
            Nothing in this time range fits the search. Try fewer terms or a wider range.
          </Empty>
        ) : (
          <Empty icon={IconLogs} title="No logs yet">
            Quiet in here. Send logs with <code>Sentry.logger</code> and they appear as they arrive.
          </Empty>
        )
      ) : (
        <ol className="divide-y overflow-hidden rounded-xl border font-mono text-xs">
          {logs.map((l) => (
            <LogLine key={l.id} log={l} showProject={showProject} onPick={onPick} />
          ))}
        </ol>
      )}
      {more && !live && (
        <div className="mt-3 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={loadingOlder}
            onClick={async () => {
              const last = logs.at(-1)!
              setLoadingOlder(true)
              try {
                const older = await getLogs({
                  data: { ...params, before: { timestamp: last.timestamp, id: last.id } },
                })
                add(older.logs, 'bottom')
                setMore(older.more)
              } finally {
                setLoadingOlder(false)
              }
            }}
          >
            Older
          </Button>
        </div>
      )}
    </>
  )
}

function Clock({ at }: { at: number }) {
  return <Time at={at} style="seconds" className="text-muted-foreground tabular-nums" />
}

/** One field of an expanded log; with `field`, its value is a menu to show only or exclude it, or copy it */
function Row({ name, value, field, onPick }: { name: string; value: string; field?: string; onPick: Pick }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{name}</dt>
      <dd className="min-w-0 break-all">
        {field ? (
          <ValueMenu
            field={field}
            value={value}
            onInclude={() => onPick(field, value, false)}
            onExclude={() => onPick(field, value, true)}
          >
            <span className="whitespace-pre-wrap">{value}</span>
          </ValueMenu>
        ) : (
          value
        )}
      </dd>
    </div>
  )
}

function LogLine({ log: l, showProject, onPick }: { log: Log; showProject: boolean; onPick: Pick }) {
  const attributes = Object.entries(JSON.parse(l.attributes) as Record<string, unknown>)
  const own = attributes.filter(([k]) => !k.startsWith('sentry.'))
  return (
    <li>
      <details className="group">
        <summary className="flex cursor-pointer items-start gap-2 px-3 py-1.5 hover:bg-muted/40">
          <IconChevronRight className="mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          <Clock at={l.timestamp} />
          <span
            className={cn(
              'w-11 shrink-0 rounded px-1 text-center text-[0.65rem] leading-4 uppercase',
              LEVEL_STYLE[l.level],
            )}
          >
            {l.level}
          </span>
          <span className="min-w-0 flex-1 break-words group-open:whitespace-pre-wrap">
            {showProject && <span className="mr-2 text-muted-foreground">{l.project}</span>}
            {l.body}
            {own.length > 0 && (
              <span className="ml-2 text-muted-foreground max-sm:hidden">
                {own
                  .slice(0, 4)
                  .map(([k, v]) => `${k}=${String(v)}`)
                  .join(' ')}
              </span>
            )}
          </span>
        </summary>
        <div className="grid gap-2 border-t bg-muted/30 px-3 py-3 pl-8">
          <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-0.5">
            {[
              ['level', l.level],
              ['release', l.release],
              ['environment', l.environment],
              ['trace', l.trace_id],
            ]
              .filter((row): row is [string, string] => row[1] !== null)
              .map(([k, v]) => (
                <Row key={k} name={k} value={v} field={k} onPick={onPick} />
              ))}
            {attributes
              .filter(([, v]) => v !== null && v !== undefined)
              .map(([k, v]) => (
                <Row key={k} name={k} value={String(v)} field={logAttributeKey(k)} onPick={onPick} />
              ))}
          </dl>
          {l.trace_id && (
            <p className="flex flex-wrap gap-3 font-sans">
              <Link to="/traces/$traceId" params={{ traceId: l.trace_id }} className="underline">
                Open trace
              </Link>
            </p>
          )}
        </div>
      </details>
    </li>
  )
}
