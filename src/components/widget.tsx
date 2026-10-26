// A dashboard's widget: its card (title, what it reads, the number, chart, table, issues or text it shows), the
// builder that makes or changes one with a preview, and the viewer that opens one full width with its numbers.
import { Link, useNavigate } from '@tanstack/react-router'
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowsMaximize,
  IconArrowUp,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconGripVertical,
  IconPencil,
  IconPlus,
  IconSelector,
  IconX,
} from '@tabler/icons-react'
import { Fragment, useEffect, useState } from 'react'
import { count, Level, percent } from '@/components/bits'
import { BigNumber, LEVEL_COLORS, PALETTE, type Series, TimeChart } from '@/components/charts'
import { ms } from '@/components/performance'
import { SearchBar } from '@/components/search-bar'
import { Time } from '@/components/time'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ValueMenu } from '@/components/value-menu'
import { change } from '@/data/charts'
import type { Range } from '@/data/logs'
import {
  type Aggregate,
  aggregatesOf,
  type Dataset,
  DATASETS,
  DISPLAYS,
  type Display,
  type Filters,
  GROUPS,
  groupsOf,
  MAX_QUERIES,
  NAMES,
  parseAggregate,
  type Unit,
  type Widget,
  type WidgetData,
  type WidgetQuery,
} from '@/data/widgets'
import { getSuggestions, previewWidget } from '@/fns'
import { cn } from '@/lib/utils'
import { addValue, isSearchableKey } from '@/search/query'

const DISPLAY_NAMES: Record<Display, string> = {
  number: 'Number',
  bar: 'Bars',
  area: 'Area',
  line: 'Line',
  table: 'Table',
  list: 'List',
  text: 'Text',
}
// A range's length, for "the … before"
const PERIODS: Record<Range, string> = { '1h': 'hour', '24h': 'day', '7d': 'week', '30d': '30 days' }
// Grid columns a widget spans on a wide screen (one column on a phone)
export const SPANS = { 1: 'md:col-span-1', 2: 'md:col-span-2', 3: 'md:col-span-3' } as const
// What a filter reads like, for the datasets whose filter is a few fixed keys
const PLACEHOLDERS: Partial<Record<Dataset, string>> = {
  transactions: 'transaction:/checkout release:1.2.*',
  sessions: 'environment:production release:1.2.*',
  monitors: 'kind:uptime monitor:homepage',
  releases: 'environment:production',
}

// A value as it reads: none (a log without a release) and the rest beyond those shown can't be filtered by
const label = (value: string | null) => (value === null ? 'Other' : value === '' ? 'None' : value)
const filterable = (value: string | null): value is string => value !== null && value !== ''

/** A value in its unit: 1.2k, 97.1%, 840 ms, 3.5 */
export function formatValue(unit: Unit, v: number | null) {
  if (v === null) return '—'
  if (unit === 'count') return count(Math.round(v))
  if (unit === 'percent') return percent(v / 100)
  if (unit === 'ms') return ms(v)
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v)
}

/** A query's name in a legend or a column: its label, else its aggregate */
export const queryName = (q: WidgetQuery) => q.label || q.aggregate

// Rates where more is good: their change reads green when it goes up
const higherIsBetter = (q: WidgetQuery) => ['crash_free_rate', 'crash_free_users', 'uptime'].includes(q.aggregate)

/** Past which threshold a number is, if any */
function toneOf(w: Widget, v: number | null): 'warning' | 'critical' | undefined {
  const t = w.thresholds
  if (!t || v === null) return undefined
  const past = (x: number) => (t.direction === 'above' ? v > x : v < x)
  return past(t.critical) ? 'critical' : past(t.warning) ? 'warning' : undefined
}

/** Where a widget's own list is: the issues, the logs, or the page of its dataset */
export function listOf(w: Widget, project: string | undefined, range: Range) {
  const query = w.queries[0]?.query || undefined
  if (w.dataset === 'logs') return { to: '/logs' as const, label: 'Open in Logs', search: { query, project, range } }
  if (w.dataset === 'issues' || w.dataset === 'events')
    return { to: '/issues' as const, label: 'Open in Issues', search: { query, project } }
  if (w.dataset === 'transactions') return { to: '/performance' as const, label: 'Open in Performance', search: {} }
  if (w.dataset === 'monitors') return { to: '/monitors' as const, label: 'Open in Monitors', search: {} }
  if (w.dataset === 'sessions' || w.dataset === 'releases')
    return { to: '/releases' as const, label: 'Open in Releases', search: {} }
}

/** Show only (or exclude) one of a widget's values: the logs or the issues, with the value added */
function usePick(w: Widget, project: string | undefined, range: Range) {
  const navigate = useNavigate()
  const field = groupsOf(w)[0] ?? 'level'
  const can = (w.dataset === 'logs' || w.dataset === 'events') && isSearchableKey(field) && field !== 'project'
  return can
    ? (value: string, negate = false) => {
        const query = addValue(w.queries[0]?.query ?? '', field, value, negate) || undefined
        if (w.dataset === 'logs') void navigate({ to: '/logs', search: { query, project, range } })
        else void navigate({ to: '/issues', search: { query, project } })
      }
    : undefined
}

/** A widget's card; `actions` are the edit mode's buttons, `onOpen` the viewer's */
export function WidgetCard({
  widget,
  data,
  project,
  range,
  actions,
  onOpen,
  dragging,
  ...drag
}: {
  widget: Widget
  data?: WidgetData
  project?: string
  range: Range
  actions?: React.ReactNode
  onOpen?: () => void
  dragging?: boolean
} & Pick<React.HTMLAttributes<HTMLDivElement>, 'draggable' | 'onDragStart' | 'onDragOver' | 'onDrop' | 'onDragEnd'>) {
  // What it reads, unless the title already says it
  const groups = widget.groupBy?.length ? ` by ${widget.groupBy.join(' and ')}` : ''
  const source = `${NAMES[widget.dataset]}${groups}`
  const about =
    widget.dataset === 'markdown' || source.toLowerCase() === widget.title.trim().toLowerCase() ? '' : source
  const queries = widget.queries
    .map((q) => [q.query, q.aggregate === 'count' ? '' : q.aggregate].filter(Boolean).join(' · '))
    .filter(Boolean)
    .join(', ')
  return (
    // A number keeps its own height beside a taller widget instead of stretching to the row's
    <Card
      size="sm"
      className={cn(
        'min-w-0',
        widget.display === 'number' && 'md:self-start',
        SPANS[widget.width],
        dragging && 'opacity-50',
        drag.draggable && 'cursor-grab',
      )}
      {...drag}
    >
      <CardHeader>
        <CardTitle className="truncate">{widget.title}</CardTitle>
        {(widget.invalid || about || queries) && (
          <CardDescription className="truncate text-xs">
            {widget.invalid ? (
              'Edit or remove this widget'
            ) : (
              <>
                {about}
                {about && queries && ' · '}
                {queries && <span className="font-mono">{queries}</span>}
              </>
            )}
          </CardDescription>
        )}
        {(actions || onOpen) && (
          <CardAction className="flex">
            {actions ??
              (onOpen && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="max-sm:size-10"
                  aria-label={`Open ${widget.title}`}
                  title="Open"
                  onClick={onOpen}
                >
                  <IconArrowsMaximize />
                </Button>
              ))}
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="min-w-0">
        {data ? (
          <WidgetView widget={widget} data={data} project={project} range={range} />
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">Saved, it shows here.</p>
        )}
      </CardContent>
    </Card>
  )
}

/** The edit mode's buttons on a card: change, duplicate, move up, move down, remove; a grip to drag it */
export function WidgetActions({
  title,
  onEdit,
  onDuplicate,
  onUp,
  onDown,
  onRemove,
}: {
  title: string
  onEdit: () => void
  onDuplicate?: () => void
  onUp?: () => void
  onDown?: () => void
  onRemove: () => void
}) {
  const size = 'max-sm:size-10'
  return (
    <>
      <span className="flex items-center px-1 text-muted-foreground max-md:hidden" title="Drag to move">
        <IconGripVertical className="size-4" />
      </span>
      <Button variant="ghost" size="icon-sm" className={size} aria-label={`Edit ${title}`} onClick={onEdit}>
        <IconPencil />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className={size}
        aria-label={`Duplicate ${title}`}
        title="Duplicate widget"
        disabled={!onDuplicate}
        onClick={onDuplicate}
      >
        <IconCopy />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className={size}
        aria-label={`Move ${title} up`}
        disabled={!onUp}
        onClick={onUp}
      >
        <IconArrowUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className={size}
        aria-label={`Move ${title} down`}
        disabled={!onDown}
        onClick={onDown}
      >
        <IconArrowDown />
      </Button>
      <Button variant="ghost" size="icon-sm" className={size} aria-label={`Remove ${title}`} onClick={onRemove}>
        <IconX />
      </Button>
    </>
  )
}

/** Markdown, the little of it a note needs: paragraphs, line breaks, **bold**, links and lists. Nothing else */
export function Markdown({ text }: { text: string }) {
  const blocks = text.trim().split(/\n\s*\n/)
  return (
    <div className="grid gap-2 text-sm leading-relaxed">
      {blocks.map((block, i) => {
        const lines = block.split('\n')
        const bullet = /^\s*[-*]\s+/
        const numbered = /^\s*\d+[.)]\s+/
        if (lines.every((l) => bullet.test(l)))
          return (
            <ul key={i} className="list-disc pl-5">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(bullet, ''))}</li>
              ))}
            </ul>
          )
        if (lines.every((l) => numbered.test(l)))
          return (
            <ol key={i} className="list-decimal pl-5">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(numbered, ''))}</li>
              ))}
            </ol>
          )
        return (
          <p key={i} className="break-words">
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}

// **bold** and [links](https://…), the rest as text; a link that isn't http or https stays text
function inline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const pattern = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g
  let last = 0
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(
      m[1] !== undefined ? (
        <strong key={m.index}>{m[1]}</strong>
      ) : (
        <a key={m.index} href={m[3]} target="_blank" rel="noreferrer noopener" className="underline">
          {m[2]}
        </a>
      ),
    )
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

/** A series' name: the query's when there are several, then its group's values */
function seriesName(w: Widget, s: { query: number; group: (string | null)[] }) {
  const grouped = groupsOf(w).length > 0
  const group = grouped ? s.group.map(label).join(' · ') : ''
  if (w.queries.length > 1) return [queryName(w.queries[s.query]), group].filter(Boolean).join(' · ')
  return grouped ? group : queryName(w.queries[0])
}

/** What a widget's data looks like: numbers with their change, a chart, a table, issues, text, or what went wrong */
export function WidgetView({
  widget: w,
  data,
  project,
  range,
  height = 180,
}: {
  widget: Widget
  data: WidgetData
  project?: string
  range: Range
  height?: number
}) {
  const pick = usePick(w, project, range)
  if (data.kind === 'error')
    return (
      <p className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
        <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 break-words">
          {w.invalid ? 'This widget can’t be read.' : 'This search can’t be shown.'} {data.message}
        </span>
      </p>
    )
  if (data.kind === 'text') return <Markdown text={data.text} />
  if (data.kind === 'number')
    return (
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        {data.values.map((v, i) => {
          const q = w.queries[i]
          const what =
            w.dataset === 'issues'
              ? `Right now, against a ${PERIODS[range]} ago`
              : `Against the ${PERIODS[range]} before`
          return (
            <BigNumber
              key={i}
              value={v.value}
              label={w.queries.length > 1 && q ? `${queryName(q)} · ${what}` : what}
              change={v.value === null || v.previous === null ? null : change(v.value, v.previous)}
              format={(n) => formatValue(v.unit, n)}
              tone={i === 0 ? toneOf(w, v.value) : undefined}
              higherIsBetter={q && higherIsBetter(q)}
            />
          )
        })}
      </div>
    )
  if (data.kind === 'series') {
    const byLevel = groupsOf(w).length === 1 && groupsOf(w)[0] === 'level'
    // A query in another unit than the first is measured on a second axis
    const right = data.units.findIndex((u) => u !== data.units[0])
    const series = data.series.map((s, i): Series => ({
      key: `s${i}`,
      label: seriesName(w, s),
      values: s.counts,
      color:
        s.value === null && groupsOf(w).length
          ? 'var(--muted-foreground)'
          : byLevel && s.value && LEVEL_COLORS[s.value]
            ? LEVEL_COLORS[s.value]
            : PALETTE[i % PALETTE.length],
      ...(right !== -1 && data.units[s.query] !== data.units[0] ? { axis: 'right' as const } : {}),
    }))
    if (!series.length)
      return <p className="py-6 text-center text-sm text-muted-foreground">Nothing in this time range.</p>
    const additive = w.queries.every((q) => ['count', 'sum'].includes(parseAggregate(q.aggregate).fn))
    return (
      <TimeChart
        x={data.x}
        series={series}
        // Averages and percentiles don't add up: they're lines side by side, never stacked
        kind={
          additive && (w.display === 'area' || w.display === 'bar') ? w.display : w.display === 'bar' ? 'bar' : 'line'
        }
        stacked={additive}
        legend={series.length > 1}
        height={height}
        format={(v) => formatValue(data.units[0], v)}
        formatRight={right === -1 ? undefined : (v) => formatValue(data.units[right], v)}
        onSeries={(key) => {
          const value = data.series[Number(key.slice(1))]?.value ?? null
          if (pick && filterable(value)) pick(value)
        }}
      />
    )
  }
  if (data.kind === 'table') {
    if (!data.rows.length)
      return <p className="py-6 text-center text-sm text-muted-foreground">Nothing matches this search.</p>
    const one = w.queries.length === 1
    const total = one ? data.rows.reduce((a, r) => a + (r.values[0] ?? 0), 0) : 0
    const share = one && data.units[0] === 'count'
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              {data.fields.map((f) => (
                <th key={f} className="py-1.5 pr-2 text-left font-mono font-normal">
                  {f || queryName(w.queries[0])}
                </th>
              ))}
              {w.queries.map((q, i) => (
                <th key={i} className="py-1.5 pl-2 text-right font-normal whitespace-nowrap">
                  {one && q.aggregate === 'count' ? (w.dataset === 'logs' ? 'Logs' : 'Events') : queryName(q)}
                </th>
              ))}
              {one && <th className="w-14 py-1.5 text-right font-normal">Change</th>}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => {
              const diff =
                one && r.values[0] !== null && r.previous[0] !== null ? change(r.values[0], r.previous[0]) : null
              const first = r.group[0]
              return (
                <tr key={r.group.join('\u0000') || 'all'} className="border-b last:border-0">
                  {r.group.map((g, i) => (
                    <td key={i} className="max-w-48 truncate py-1.5 pr-2 font-mono max-sm:py-2.5">
                      {i === 0 && pick && filterable(first) ? (
                        <ValueMenu
                          field={groupsOf(w)[0]}
                          value={first}
                          onInclude={() => pick(first)}
                          onExclude={() => pick(first, true)}
                        >
                          {first}
                        </ValueMenu>
                      ) : (
                        <span className={cn(!filterable(g) && 'text-muted-foreground')}>{label(g)}</span>
                      )}
                      {i === 0 && share && (
                        <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-foreground/50"
                            style={{ width: `${total > 0 ? ((r.values[0] ?? 0) / total) * 100 : 0}%` }}
                          />
                        </div>
                      )}
                    </td>
                  ))}
                  {r.values.map((v, i) => (
                    <td key={i} className="py-1.5 pl-2 text-right align-top whitespace-nowrap">
                      {formatValue(data.units[i], v)}
                    </td>
                  ))}
                  {one && (
                    <td
                      className={cn(
                        'py-1.5 text-right align-top',
                        diff === null || Math.abs(diff) < 0.005
                          ? 'text-muted-foreground'
                          : diff > 0 !== higherIsBetter(w.queries[0])
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-emerald-600 dark:text-emerald-400',
                      )}
                    >
                      {r.previous[0] === 0 || r.previous[0] === null
                        ? 'new'
                        : diff === null
                          ? '—'
                          : `${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${Math.round(Math.abs(diff) * 100)}%`}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }
  if (!data.issues.length) return <p className="py-6 text-center text-sm text-muted-foreground">No issues match.</p>
  return (
    <ul className="-mx-1 divide-y">
      {data.issues.map((i) => (
        <li key={i.id}>
          <Link
            to="/issues/$issueId"
            params={{ issueId: String(i.id) }}
            className="flex items-center gap-2.5 rounded-md px-1 py-2 hover:bg-muted/50"
          >
            <Level level={i.level} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{i.title}</p>
              <p className="truncate text-xs text-muted-foreground">
                {i.project} · {i.culprit || 'no culprit'}
              </p>
            </div>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{count(i.count)}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

// ---- The viewer ----

type Column = { label: string; kind: 'time' | 'text' | Unit; align?: 'right' }
type Cell = number | string | null

/** A widget's data as rows: a bucket per row for a chart, a group per row for a table, an issue or a query */
function rowsOf(w: Widget, data: WidgetData): { columns: Column[]; rows: Cell[][] } {
  if (data.kind === 'series')
    return {
      columns: [
        { label: 'Time', kind: 'time' },
        ...data.series.map((s) => ({ label: seriesName(w, s), kind: data.units[s.query], align: 'right' as const })),
      ],
      rows: data.x.map((at, i) => [at, ...data.series.map((s) => s.counts[i])]),
    }
  if (data.kind === 'table')
    return {
      columns: [
        ...data.fields.map((f) => ({ label: f || 'All', kind: 'text' as const })),
        ...w.queries.map((q, i) => ({ label: queryName(q), kind: data.units[i], align: 'right' as const })),
      ],
      rows: data.rows.map((r) => [...r.group.map(label), ...r.values]),
    }
  if (data.kind === 'number')
    return {
      columns: [
        { label: 'Query', kind: 'text' },
        { label: 'Now', kind: data.values[0]?.unit ?? 'count', align: 'right' },
        { label: 'Before', kind: data.values[0]?.unit ?? 'count', align: 'right' },
      ],
      rows: data.values.map((v, i) => [queryName(w.queries[i]), v.value, v.previous]),
    }
  if (data.kind === 'list')
    return {
      columns: [
        { label: 'Issue', kind: 'text' },
        { label: 'Project', kind: 'text' },
        { label: 'Events', kind: 'count', align: 'right' },
      ],
      rows: data.issues.map((i) => [i.title, i.project, i.count]),
    }
  return { columns: [], rows: [] }
}

const PAGE = 20

/** A widget full width, then its numbers as a table to sort and page through, and a way to its own list */
export function WidgetViewer({
  widget,
  data,
  project,
  range,
  onClose,
}: {
  widget: Widget
  data: WidgetData
  project?: string
  range: Range
  onClose: () => void
}) {
  const { columns, rows } = rowsOf(widget, data)
  const [sort, setSort] = useState<{ by: number; dir: 1 | -1 } | null>(null)
  const [page, setPage] = useState(0)
  const sorted = sort
    ? [...rows].sort((a, b) => {
        const [x, y] = [a[sort.by], b[sort.by]]
        if (x === null) return 1
        if (y === null) return -1
        return sort.dir * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)))
      })
    : rows
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE))
  const shown = sorted.slice(page * PAGE, page * PAGE + PAGE)
  const list = listOf(widget, project, range)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{widget.title}</DialogTitle>
          <DialogDescription>
            {NAMES[widget.dataset]}
            {widget.groupBy?.length ? ` by ${widget.groupBy.join(' and ')}` : ''}
          </DialogDescription>
        </DialogHeader>
        {/* A table or list is its own sortable table below; a chart or number shows above it */}
        {data.kind !== 'table' && data.kind !== 'list' && (
          <WidgetView widget={widget} data={data} project={project} range={range} height={320} />
        )}
        {columns.length > 0 && rows.length > 0 && (
          <div className="grid gap-2">
            <div className="overflow-x-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    {columns.map((c, i) => (
                      <TableHead key={i} className={cn(c.align === 'right' && 'text-right')}>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 hover:text-foreground max-sm:min-h-10"
                          onClick={() => {
                            setSort(sort?.by === i ? { by: i, dir: sort.dir === 1 ? -1 : 1 } : { by: i, dir: -1 })
                            setPage(0)
                          }}
                          aria-label={`Sort by ${c.label}`}
                        >
                          {c.label}
                          {sort?.by === i ? (
                            sort.dir === 1 ? (
                              <IconArrowUp className="size-3" />
                            ) : (
                              <IconArrowDown className="size-3" />
                            )
                          ) : (
                            <IconSelector className="size-3 opacity-50" />
                          )}
                        </button>
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody className="tabular-nums">
                  {shown.map((r, i) => (
                    <TableRow key={i}>
                      {r.map((v, j) => {
                        const c = columns[j]
                        return (
                          <TableCell key={j} className={cn('max-w-72 truncate', c.align === 'right' && 'text-right')}>
                            {c.kind === 'time' && typeof v === 'number' ? (
                              <Time at={v} style="dayTime" />
                            ) : c.kind === 'text' ? (
                              v
                            ) : c.kind === 'time' ? null : (
                              formatValue(c.kind, typeof v === 'number' ? v : null)
                            )}
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {pages > 1 && (
              <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
                <span className="tabular-nums">
                  Page {page + 1} of {pages}
                </span>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="max-sm:size-10"
                  aria-label="Previous page"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  <IconChevronLeft />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="max-sm:size-10"
                  aria-label="Next page"
                  disabled={page >= pages - 1}
                  onClick={() => setPage(page + 1)}
                >
                  <IconChevronRight />
                </Button>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          {list && (
            <Button variant="outline" asChild>
              <Link to={list.to} search={list.search as never}>
                {list.label}
              </Link>
            </Button>
          )}
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---- The builder ----

const newId = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')

/** A widget as it's saved: what its display and dataset don't use dropped; one redone is valid again */
function normalized(w: Widget): Widget {
  const { groupBy, invalid: _, sort, limit, thresholds, text, ...rest } = w
  if (w.dataset === 'markdown') return { ...rest, queries: [], text: text ?? '' }
  const out: Widget = { ...rest }
  const grouped = w.dataset !== 'issues' && w.display !== 'number'
  const groups = (groupBy ?? []).filter(Boolean)
  if (grouped && groups.length && !(w.dataset === 'releases')) out.groupBy = groups
  if (grouped && sort) out.sort = sort
  if ((grouped || w.display === 'list') && limit) out.limit = limit
  if (w.display === 'number' && thresholds) out.thresholds = thresholds
  return out
}

const DEBOUNCE = 400
const FN_NAMES: Record<string, string> = {
  count: 'Count',
  'count_unique(user)': 'Users',
  failure_rate: 'Failure rate',
  crash_free_rate: 'Crash-free rate',
  uptime: 'Uptime',
  avg: 'Average',
  sum: 'Sum',
  min: 'Minimum',
  max: 'Maximum',
  p50: 'p50',
  p75: 'p75',
  p95: 'p95',
  p99: 'p99',
}

/** A widget to start from for a dataset: its first display and aggregate, the markdown its text */
function startOf(dataset: Dataset, old: Widget): Widget {
  const display = DISPLAYS[dataset].includes(old.display) ? old.display : DISPLAYS[dataset][0]
  const { plain } = aggregatesOf(dataset)
  if (dataset === 'markdown') return { ...old, dataset, display, queries: [], text: old.text ?? '' }
  // Issues and events share the issues' search; the others start empty
  const sameSearch = (a: Dataset, b: Dataset) =>
    a === b || (['issues', 'events'].includes(a) && ['issues', 'events'].includes(b))
  return {
    ...old,
    dataset,
    display,
    queries: [{ query: sameSearch(dataset, old.dataset) ? (old.queries[0]?.query ?? '') : '', aggregate: plain[0] }],
    groupBy: undefined,
    sort: undefined,
    thresholds: undefined,
  }
}

/**
 * Adding or changing a widget: title, dataset, up to 3 queries each with its aggregate, the group-by, sort and
 * limit, thresholds for a number, how it's shown, its width, and a preview (`previewWidget`) over the dashboard's
 * range, project and filters, asked for 400 ms after a change
 */
export function WidgetDialog({
  widget,
  data,
  project,
  range,
  filters,
  onSave,
  onClose,
}: {
  widget?: Widget
  data?: WidgetData
  project?: string
  range: Range
  filters?: Filters
  onSave: (widget: Widget, data?: WidgetData) => void
  onClose: () => void
}) {
  const [w, setW] = useState<Widget>(
    () =>
      widget ?? {
        id: newId(),
        title: '',
        dataset: 'events',
        display: 'bar',
        queries: [{ query: '', aggregate: 'count' }],
        width: 1,
      },
  )
  const set = (change: Partial<Widget>) => setW((old) => ({ ...old, ...change }))
  // What's typed in each query's bar, searched or not: Add saves it (the preview follows what was searched)
  const [typed, setTyped] = useState(() => w.queries.map((q) => q.query))
  const setQuery = (i: number, change: Partial<WidgetQuery>) =>
    set({ queries: w.queries.map((q, j) => (j === i ? { ...q, ...change } : q)) })
  // The title doesn't change what's shown, so typing it asks for nothing
  const shown = normalized({ ...w, title: 'Preview' })
  const key = JSON.stringify([shown, project, range, filters])
  // The preview of the widget as it was when asked; while it's not the one asked for last, it's on its way
  const [preview, setPreview] = useState<{ key: string; data: WidgetData } | undefined>(
    widget && data ? { key, data } : undefined,
  )
  useEffect(() => {
    if (preview?.key === key) return
    let live = true
    const timer = setTimeout(() => {
      previewWidget({ data: { widget: JSON.parse(key)[0] as Widget, project, range, ...filtersOf(filters) } }).then(
        (d) => live && setPreview({ key, data: d }),
        (error: unknown) =>
          live &&
          setPreview({
            key,
            data: { kind: 'error', message: error instanceof Error ? error.message : 'The preview couldn’t load.' },
          }),
      )
    }, DEBOUNCE)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [key, preview?.key, project, range, filters])
  const displays = DISPLAYS[w.dataset]
  const grouped = !['issues', 'markdown', 'releases'].includes(w.dataset) && w.display !== 'number'
  const markdown = w.dataset === 'markdown'
  const groupBy = w.groupBy ?? []
  // With nothing picked, one count of events or logs is split by level
  const byLevel = groupsOf({ ...w, groupBy: undefined })[0] === 'level'
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            const saved = {
              ...w,
              queries: w.queries.map((q, i) => ({ ...q, query: typed[i] ?? q.query })),
              title: w.title.trim(),
            }
            const same = saved.queries.every((q, i) => q.query === w.queries[i].query) && preview?.key === key
            onSave(normalized(saved), same ? preview.data : undefined)
          }}
        >
          <DialogHeader>
            <DialogTitle>{widget ? 'Edit widget' : 'Add widget'}</DialogTitle>
            <DialogDescription>Choose what to read and how to show it.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="widget-title">Title</Label>
              <Input
                id="widget-title"
                value={w.title}
                onChange={(e) => set({ title: e.target.value })}
                required
                maxLength={80}
                placeholder="Errors by release"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="widget-dataset">Of</Label>
              <Select
                value={w.dataset}
                onValueChange={(v) => {
                  const next = startOf(v as Dataset, w)
                  setW(next)
                  setTyped(next.queries.map((q) => q.query))
                }}
              >
                <SelectTrigger id="widget-dataset" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DATASETS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {NAMES[d]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {markdown ? (
            <div className="grid gap-2">
              <Label htmlFor="widget-text">Text</Label>
              <Textarea
                id="widget-text"
                value={w.text ?? ''}
                onChange={(e) => set({ text: e.target.value })}
                maxLength={4000}
                rows={6}
                required
                placeholder={
                  '**Releases** ship on Mondays.\n\n- Check crash-free sessions first\n- [Runbook](https://example.com)'
                }
              />
              <p className="text-xs text-muted-foreground">
                Paragraphs, line breaks, **bold**, links and lists starting with - or 1.
              </p>
            </div>
          ) : (
            <div className="grid gap-3">
              <Label>{w.queries.length > 1 ? 'Queries' : 'Query'}</Label>
              {w.queries.map((q, i) => (
                <QueryRow
                  key={`${w.dataset}-${i}`}
                  index={i}
                  dataset={w.dataset}
                  query={q}
                  several={w.queries.length > 1}
                  project={project}
                  range={range}
                  onChange={(change) => setQuery(i, change)}
                  onTyped={(text) => setTyped((t) => t.map((x, j) => (j === i ? text : x)))}
                  onRemove={
                    w.queries.length > 1
                      ? () => {
                          set({ queries: w.queries.filter((_, j) => j !== i) })
                          setTyped((t) => t.filter((_, j) => j !== i))
                        }
                      : undefined
                  }
                />
              ))}
              {w.queries.length < MAX_QUERIES && !(w.dataset === 'issues' && w.display === 'list') && (
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="max-sm:h-10"
                    onClick={() => {
                      const last = w.queries.at(-1)!
                      set({ queries: [...w.queries, { query: typed.at(-1) ?? last.query, aggregate: last.aggregate }] })
                      setTyped((t) => [...t, t.at(-1) ?? ''])
                    }}
                  >
                    <IconPlus data-icon="inline-start" />
                    Add query
                  </Button>
                </div>
              )}
            </div>
          )}
          <div className="grid gap-2">
            <Label>Show as</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={w.display}
              onValueChange={(v) => v && set({ display: v as Display })}
              className="flex-wrap"
            >
              {displays.map((d) => (
                <ToggleGroupItem key={d} value={d} className="max-sm:h-10 max-sm:px-3">
                  {DISPLAY_NAMES[d]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          {grouped && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="widget-group">Group by</Label>
                <GroupBy
                  id="widget-group"
                  dataset={w.dataset}
                  value={groupBy[0]}
                  project={project}
                  range={range}
                  none={byLevel ? 'Level' : 'Nothing'}
                  exclude={byLevel ? 'level' : undefined}
                  onChange={(g) => set({ groupBy: g ? [g, ...groupBy.slice(1).filter((x) => x !== g)] : undefined })}
                />
              </div>
              {groupBy[0] && (
                <div className="grid gap-2">
                  <Label htmlFor="widget-group-2">Then by</Label>
                  <GroupBy
                    id="widget-group-2"
                    dataset={w.dataset}
                    value={groupBy[1]}
                    project={project}
                    range={range}
                    none="Nothing"
                    exclude={groupBy[0]}
                    onChange={(g) => set({ groupBy: g ? [groupBy[0], g] : [groupBy[0]] })}
                  />
                </div>
              )}
            </div>
          )}
          {(grouped || w.dataset === 'releases' || w.display === 'list') && (
            <div className="grid gap-4 sm:grid-cols-3">
              {w.display !== 'list' && (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="widget-sort">Sort by</Label>
                    <Select
                      value={w.sort ? `${w.sort.by}-${w.sort.dir}` : 'value-desc'}
                      onValueChange={(v) => {
                        const [by, dir] = v.split('-') as ['value' | 'name', 'asc' | 'desc']
                        set({ sort: by === 'value' && dir === 'desc' ? undefined : { by, dir } })
                      }}
                    >
                      <SelectTrigger id="widget-sort" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="value-desc">Largest first</SelectItem>
                        <SelectItem value="value-asc">Smallest first</SelectItem>
                        <SelectItem value="name-asc">Name, A to Z</SelectItem>
                        <SelectItem value="name-desc">Name, Z to A</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
              <div className="grid gap-2">
                <Label htmlFor="widget-limit">{w.display === 'list' ? 'Issues shown' : 'Groups shown'}</Label>
                <Input
                  id="widget-limit"
                  type="number"
                  min={1}
                  max={50}
                  value={w.limit ?? ''}
                  placeholder={w.display === 'list' ? '10' : '8'}
                  onChange={(e) =>
                    set({ limit: e.target.value ? Math.min(50, Math.max(1, Number(e.target.value))) : undefined })
                  }
                />
              </div>
            </div>
          )}
          {w.display === 'number' && !markdown && (
            <ThresholdsField value={w.thresholds} onChange={(thresholds) => set({ thresholds })} />
          )}
          <div className="grid gap-2">
            <Label>Width</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={String(w.width)}
              onValueChange={(v) => v && set({ width: Number(v) as Widget['width'] })}
            >
              <ToggleGroupItem value="1" className="max-sm:h-10 max-sm:px-3">
                A third
              </ToggleGroupItem>
              <ToggleGroupItem value="2" className="max-sm:h-10 max-sm:px-3">
                Two thirds
              </ToggleGroupItem>
              <ToggleGroupItem value="3" className="max-sm:h-10 max-sm:px-3">
                Full
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="grid gap-2">
            <p className="text-sm font-medium">Preview</p>
            <div className="rounded-xl border p-3" aria-busy={preview?.key !== key}>
              {preview?.key === key ? (
                <WidgetView widget={shown} data={preview.data} project={project} range={range} />
              ) : (
                <Skeleton className="h-[180px] w-full" />
              )}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">{widget ? 'Done' : 'Add'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** A filter bar's values as `getDashboard` and `previewWidget` take them */
export const filtersOf = (f?: Filters) => ({ environment: f?.environment, release: f?.release, filter: f?.query })

/** One query of a widget: its search, its aggregate (a function and, for some, a field), its label */
function QueryRow({
  index,
  dataset,
  query: q,
  several,
  project,
  range,
  onChange,
  onTyped,
  onRemove,
}: {
  index: number
  dataset: Dataset
  query: WidgetQuery
  several: boolean
  project?: string
  range: Range
  onChange: (change: Partial<WidgetQuery>) => void
  onTyped: (text: string) => void
  onRemove?: () => void
}) {
  const { plain, fns, fields } = aggregatesOf(dataset)
  const { fn, field } = parseAggregate(q.aggregate)
  const [attribute, setAttribute] = useState(field ?? 'duration')
  const scope = dataset === 'logs' ? 'logs' : dataset === 'issues' || dataset === 'events' ? 'issues' : undefined
  const placeholder = PLACEHOLDERS[dataset]
  const options = [...plain, ...fns]
  return (
    <div className="grid gap-2 rounded-xl border p-3">
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          {scope ? (
            <SearchBar
              scope={scope}
              query={q.query}
              project={project}
              range={range}
              placeholder={scope === 'logs' ? 'level:error release:1.0' : 'is:unresolved level:fatal'}
              onSearch={(query) => {
                onChange({ query })
                onTyped(query)
              }}
              onChange={onTyped}
            />
          ) : (
            <Input
              aria-label={`Filter of query ${index + 1}`}
              defaultValue={q.query}
              placeholder={placeholder}
              className="font-mono"
              onChange={(e) => onTyped(e.target.value)}
              onBlur={(e) => onChange({ query: e.target.value })}
            />
          )}
        </div>
        {onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="max-sm:size-10"
            aria-label={`Remove query ${index + 1}`}
            onClick={onRemove}
          >
            <IconX />
          </Button>
        )}
      </div>
      {(options.length > 1 || several) && (
        <div className="grid gap-2 sm:grid-cols-3">
          {options.length > 1 && (
            <Select
              value={fn}
              onValueChange={(v) => {
                const takesField = (fns as readonly string[]).includes(v)
                onChange({ aggregate: (takesField ? `${v}(${fields?.[0] ?? attribute})` : v) as Aggregate })
              }}
            >
              <SelectTrigger aria-label={`Function of query ${index + 1}`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((o) => (
                  <SelectItem key={o} value={o}>
                    {FN_NAMES[o] ?? o}
                    {(fns as readonly string[]).includes(o) && fields ? ` of ${fields[0]}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {field !== undefined && !fields && (
            <Input
              aria-label={`Attribute of query ${index + 1}`}
              value={attribute}
              placeholder="duration"
              className="font-mono"
              onChange={(e) => {
                const name = e.target.value.trim()
                setAttribute(name)
                if (/^[\w.-]{1,60}$/.test(name)) onChange({ aggregate: `${fn}(${name})` as Aggregate })
              }}
            />
          )}
          {several && (
            <Input
              aria-label={`Label of query ${index + 1}`}
              value={q.label ?? ''}
              maxLength={40}
              placeholder="Label"
              onChange={(e) => onChange({ label: e.target.value || undefined })}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** A number's thresholds: past warning it reads amber, past critical red */
function ThresholdsField({
  value,
  onChange,
}: {
  value?: Widget['thresholds']
  onChange: (t?: Widget['thresholds']) => void
}) {
  const [direction, setDirection] = useState(value?.direction ?? 'above')
  const [warning, setWarning] = useState(value ? String(value.warning) : '')
  const [critical, setCritical] = useState(value ? String(value.critical) : '')
  const update = (d: string, w: string, c: string) =>
    onChange(
      w !== '' && c !== '' && Number.isFinite(Number(w)) && Number.isFinite(Number(c))
        ? { direction: d as 'above' | 'below', warning: Number(w), critical: Number(c) }
        : undefined,
    )
  return (
    <div className="grid gap-2">
      <Label>Thresholds</Label>
      <div className="grid gap-2 sm:grid-cols-3">
        <Select
          value={direction}
          onValueChange={(d) => {
            setDirection(d as 'above' | 'below')
            update(d, warning, critical)
          }}
        >
          <SelectTrigger aria-label="Colour it when it goes" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="above">When above</SelectItem>
            <SelectItem value="below">When below</SelectItem>
          </SelectContent>
        </Select>
        <Input
          type="number"
          step="any"
          aria-label="Warning value"
          placeholder="Warning"
          value={warning}
          onChange={(e) => {
            setWarning(e.target.value)
            update(direction, e.target.value, critical)
          }}
        />
        <Input
          type="number"
          step="any"
          aria-label="Critical value"
          placeholder="Critical"
          value={critical}
          onChange={(e) => {
            setCritical(e.target.value)
            update(direction, warning, e.target.value)
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">The number turns amber past warning and red past critical.</p>
    </div>
  )
}

/** A field to group by: the dataset's own, and for logs any attribute (the stored keys, asked for once) */
export function GroupBy({
  id,
  dataset,
  value,
  project,
  range,
  none,
  exclude,
  attributesOnly,
  onChange,
  className,
}: {
  id?: string
  dataset: Dataset
  value?: string
  project?: string
  range?: Range
  none: string
  exclude?: string
  // Only logs' attributes, not their columns: what a function of a number reads
  attributesOnly?: boolean
  onChange: (groupBy: string | undefined) => void
  className?: string
}) {
  const [keys, setKeys] = useState<string[]>([])
  const [asked, setAsked] = useState(false)
  const load = (open: boolean) => {
    if (!open || asked || dataset !== 'logs') return
    setAsked(true)
    void getSuggestions({ data: { scope: 'logs', project, range } }).then((r) => {
      if ('keys' in r) setKeys(r.keys.filter((k) => k.kind === 'tag').map((k) => k.key))
    })
  }
  const columns = attributesOnly ? [] : GROUPS[dataset].filter((c) => c !== exclude)
  const attributes = [...new Set([...(value && !columns.includes(value) ? [value] : []), ...keys])].filter(
    (k) => k !== exclude,
  )
  return (
    <Select value={value ?? 'none'} onValueChange={(v) => onChange(v === 'none' ? undefined : v)} onOpenChange={load}>
      <SelectTrigger id={id} className={cn('w-full', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="none">{none}</SelectItem>
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
