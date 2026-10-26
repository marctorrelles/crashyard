import { createFileRoute, Link, useHydrated, useNavigate } from '@tanstack/react-router'
import { ChevronRightIcon, MinusIcon, PauseIcon, PlayIcon, PlusIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { count } from '@/components/bits'
import { BarList, LEVEL_COLORS, PALETTE, type Series, TimeChart } from '@/components/charts'
import { SearchBar } from '@/components/search-bar'
import { Empty, PageHeader, Shell, useProjects } from '@/components/shell'
import { Button } from '@/components/ui/button'
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
import { change } from '@/data/charts'
import { GROUP_COLUMNS, MAX_SPAN } from '@/data/logs'
import { getLogChart, getLogGroups, getLogs, getSuggestions } from '@/fns'
import { cn } from '@/lib/utils'
import { addValue, isSearchableKey, logAttributeKey } from '@/search/query'

const RANGES = { '1h': 'Last hour', '24h': 'Last day', '7d': 'Last week', '30d': 'Last 30 days' } as const
type Range = keyof typeof RANGES
// `from` and `to` (ms, a drag on the chart) stand in for `range` while they're set; `range` stays for Reset
type Search = { project?: string; query?: string; range?: Range; from?: number; to?: number; groupBy?: string }

const whole = (v: unknown) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : undefined)

export const Route = createFileRoute('/logs')({
  validateSearch: (s: Record<string, unknown>): Search => {
    const from = whole(s.from)
    const to = whole(s.to)
    // An exact span counts only whole (both ends, in order, 90 days at most); else the range does
    const exact = from !== undefined && to !== undefined && from < to && to - from <= MAX_SPAN
    return {
      project: typeof s.project === 'string' && s.project ? s.project : undefined,
      query: typeof s.query === 'string' && s.query ? s.query : undefined,
      range: typeof s.range === 'string' && s.range in RANGES ? (s.range as Range) : undefined,
      from: exact ? from : undefined,
      to: exact ? to : undefined,
      groupBy: typeof s.groupBy === 'string' && /^[\w.-]{1,60}$/.test(s.groupBy) ? s.groupBy : undefined,
    }
  },
  loaderDeps: ({ search }) => search,
  // With a group-by, the chart is its groups (and the table over the list); else logs by level
  loader: async ({ deps }) => {
    const params = paramsOf(deps)
    const [list, chart, groups] = await Promise.all([
      getLogs({ data: params }),
      deps.groupBy ? undefined : getLogChart({ data: params }),
      deps.groupBy ? getLogGroups({ data: { ...params, groupBy: deps.groupBy } }) : undefined,
    ])
    return { ...list, chart, groups }
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
  const navigate = useNavigate({ from: Route.fullPath })
  const query = search.query ?? ''
  const go = (change: Partial<Search>) => void navigate({ search: (s) => ({ ...s, ...change }) })
  const [live, setLive] = useState(false)
  const params = paramsOf(search)
  const custom = 'from' in params
  const pick: Pick = (key, value, negate) => go({ query: addValue(query, key, value, negate) || undefined })
  // Keys whose values all differ (an id, a duration) say nothing as a facet
  const facets = new Map(
    [...Map.groupBy(data.facets, (f) => f.key)].filter(([, values]) => values[0].n > 1).slice(0, 10),
  )
  // Every log has a level, so the levels' counts add up to the sample the facets count over
  const sampled = data.facets.filter((f) => f.key === 'level').reduce((sum, f) => sum + f.n, 0)
  const chart = chartOf(data, search.groupBy)
  return (
    <Shell wide>
      <PageHeader title="Logs">{useProjects().find((p) => p.slug === search.project)?.name}</PageHeader>
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="min-w-60 flex-1">
          <SearchBar
            scope="logs"
            query={query}
            project={search.project}
            range={search.range}
            placeholder='level:error song:42 "export failed"'
            onSearch={(q) => go({ query: q || undefined })}
          />
        </div>
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
            <XIcon data-icon="inline-start" />
            Reset
          </Button>
        )}
        <GroupBy
          value={search.groupBy}
          project={search.project}
          range={search.range}
          onChange={(groupBy) => go({ groupBy })}
        />
        <Button
          variant={live ? 'default' : 'outline'}
          onClick={() => setLive(!live)}
          aria-pressed={live}
          disabled={custom}
          title={custom ? 'Live follows the newest logs: reset the time first' : undefined}
        >
          {live ? <PauseIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
          Live
        </Button>
      </div>

      <section className="mb-3 rounded-xl border p-3 pb-1" aria-label="Logs over time">
        <p className="mb-2 text-sm">
          <span className="font-medium tabular-nums">{count(chart.total)}</span>{' '}
          <span className="text-muted-foreground">
            logs{search.groupBy && !Object.hasOwn(GROUP_COLUMNS, search.groupBy) && <> with {search.groupBy}</>}, per{' '}
            {INTERVALS[chart.interval]}
            {search.groupBy && Object.hasOwn(GROUP_COLUMNS, search.groupBy) && <> by {search.groupBy}</>}
            {chart.before > 0 && (
              <span className="max-sm:hidden">
                , {count(chart.before)} in the{' '}
                {'range' in params ? PERIODS[params.range] : spanText(chart.to - chart.from)} before
              </span>
            )}
            <span className="pointer-coarse:hidden"> · drag across to zoom in</span>
          </span>
        </p>
        <TimeChart
          x={chart.x}
          series={chart.series}
          previous={chart.previous}
          height={140}
          onZoom={(from, to) => go({ from: Math.max(from, chart.from), to: Math.min(to, chart.to) })}
        />
      </section>

      {data.groups && search.groupBy && (
        <Groups groups={data.groups.groups} total={data.groups.total} field={search.groupBy} onPick={pick} />
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
    </Shell>
  )
}

// What a group's value reads as: a missing release or environment is none, the rest beyond the top is other
const groupLabel = (value: string | null) => (value === null ? 'Other' : value === '' ? '(none)' : value)

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
  value,
  project,
  range,
  onChange,
}: {
  value?: string
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
  const columns = Object.keys(GROUP_COLUMNS)
  const attributes = [...new Set([...(value && !columns.includes(value) ? [value] : []), ...keys])]
  return (
    <Select value={value ?? 'none'} onValueChange={(v) => onChange(v === 'none' ? undefined : v)} onOpenChange={load}>
      <SelectTrigger className="w-40" aria-label="Group by">
        <span className="flex min-w-0 gap-1.5">
          <span className="text-muted-foreground">By</span>
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent align="end">
        <SelectGroup>
          <SelectItem value="none">nothing</SelectItem>
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
                        <PlusIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className={action}
                        aria-label={`Exclude ${g.value}`}
                        title="Exclude this"
                        onClick={() => onPick(field, g.value!, true)}
                      >
                        <MinusIcon />
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
  const newest = useRef(logs[0])
  useEffect(() => {
    newest.current = logs[0]
  }, [logs])
  useEffect(() => {
    if (!live) return
    const timer = setInterval(async () => {
      const head = newest.current
      const fresh = await getLogs({
        data: { ...params, after: head ? { timestamp: head.timestamp, id: head.id } : undefined },
      })
      if (fresh.logs.length) setLogs((l) => [...fresh.logs, ...l].slice(0, 1000))
    }, 2000)
    return () => clearInterval(timer)
  }, [live, params])
  return (
    <>
      {logs.length === 0 ? (
        <Empty title="No logs">
          {params.query || 'from' in params
            ? 'Nothing matches in this time range.'
            : 'Logs sent with Sentry.logger show up here.'}
        </Empty>
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
            onClick={async () => {
              const last = logs.at(-1)!
              const older = await getLogs({ data: { ...params, before: { timestamp: last.timestamp, id: last.id } } })
              setLogs((l) => [...l, ...older.logs])
              setMore(older.more)
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
  // The browser's time once it's here; the server renders UTC
  const hydrated = useHydrated()
  const d = new Date(at)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const text = hydrated
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
    : `${d.toISOString().slice(11, 23)}Z`
  return (
    <time
      dateTime={d.toISOString()}
      title={hydrated ? d.toLocaleString() : d.toUTCString()}
      className="text-muted-foreground tabular-nums"
    >
      {text}
    </time>
  )
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
          <ChevronRightIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
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
              <Link to="/logs" search={{ query: `trace:${l.trace_id}`, range: '30d' }} className="underline">
                Logs of this trace
              </Link>
              <Link to="/issues" search={{ query: `trace:${l.trace_id}` }} className="underline">
                Its issues
              </Link>
            </p>
          )}
        </div>
      </details>
    </li>
  )
}
