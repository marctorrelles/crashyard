// A dashboard's widget: its card (title, what it searches, the number, chart, table or issues it shows) and the
// dialog that makes or changes one, with a preview of what it will show.
import { Link, useNavigate } from '@tanstack/react-router'
import { IconAlertTriangle, IconArrowDown, IconArrowUp, IconPencil, IconX } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { count, Level } from '@/components/bits'
import { BigNumber, LEVEL_COLORS, PALETTE, type Series, TimeChart } from '@/components/charts'
import { SearchBar } from '@/components/search-bar'
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ValueMenu } from '@/components/value-menu'
import { change } from '@/data/charts'
import { type Dataset, DISPLAYS, type Display, type Widget, type WidgetData } from '@/data/dashboards'
import { GROUP_COLUMNS, type Range } from '@/data/logs'
import { getSuggestions, previewWidget } from '@/fns'
import { cn } from '@/lib/utils'
import { addValue, isSearchableKey } from '@/search/query'

export const DATASET_NAMES: Record<Dataset, string> = { issues: 'Issues', events: 'Issue events', logs: 'Logs' }
const DISPLAY_NAMES: Record<Display, string> = {
  number: 'Number',
  bar: 'Bars',
  area: 'Area',
  line: 'Line',
  table: 'Table',
  list: 'List',
}
// A range's length, for "the … before"
const PERIODS: Record<Range, string> = { '1h': 'hour', '24h': 'day', '7d': 'week', '30d': '30 days' }
// Grid columns a widget spans on a wide screen (one column on a phone)
export const SPANS = { 1: 'md:col-span-1', 2: 'md:col-span-2', 3: 'md:col-span-3' } as const

// A value as it reads: none (a log without a release) and the rest beyond the top 8 can't be filtered by
const label = (value: string | null) => (value === null ? 'Other' : value === '' ? '(none)' : value)
const filterable = (value: string | null): value is string => value !== null && value !== ''

/** Show only (or exclude) one of a widget's values: its list, the logs or the issues, with the value added */
function usePick(w: Widget, project: string | undefined, range: Range) {
  const navigate = useNavigate()
  const field = w.groupBy ?? 'level'
  return (value: string, negate = false) => {
    const query = addValue(w.query, field, value, negate) || undefined
    if (w.dataset === 'logs') void navigate({ to: '/logs', search: { query, project, range } })
    else void navigate({ to: '/issues', search: { query, project } })
  }
}

/** A widget's card; `actions` are the edit mode's buttons */
export function WidgetCard({
  widget,
  data,
  project,
  range,
  actions,
}: {
  widget: Widget
  data?: WidgetData
  project?: string
  range: Range
  actions?: React.ReactNode
}) {
  // What it counts, unless the title already says it
  const source = `${DATASET_NAMES[widget.dataset]}${widget.groupBy ? ` by ${widget.groupBy}` : ''}`
  const about = source.toLowerCase() === widget.title.trim().toLowerCase() ? '' : source
  return (
    // A number keeps its own height beside a taller widget instead of stretching to the row's
    <Card size="sm" className={cn('min-w-0', widget.display === 'number' && 'md:self-start', SPANS[widget.width])}>
      <CardHeader>
        <CardTitle className="truncate">{widget.title}</CardTitle>
        {(widget.invalid || about || widget.query) && (
          <CardDescription className="truncate text-xs">
            {widget.invalid ? (
              'Remove it, or edit it anew'
            ) : (
              <>
                {about}
                {about && widget.query && ' · '}
                {widget.query && <span className="font-mono">{widget.query}</span>}
              </>
            )}
          </CardDescription>
        )}
        {actions && <CardAction className="flex">{actions}</CardAction>}
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

/** The edit mode's buttons on a card: change, move up, move down, remove */
export function WidgetActions({
  title,
  onEdit,
  onUp,
  onDown,
  onRemove,
}: {
  title: string
  onEdit: () => void
  onUp?: () => void
  onDown?: () => void
  onRemove: () => void
}) {
  const size = 'max-sm:size-10'
  return (
    <>
      <Button variant="ghost" size="icon-sm" className={size} aria-label={`Edit ${title}`} onClick={onEdit}>
        <IconPencil />
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

/** What a widget's data looks like: a number with its change, a chart, a table of values, issues, or what went wrong */
function WidgetView({
  widget: w,
  data,
  project,
  range,
}: {
  widget: Widget
  data: WidgetData
  project?: string
  range: Range
}) {
  const pick = usePick(w, project, range)
  if (data.kind === 'error')
    return (
      <p className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
        <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 break-words">
          {w.invalid ? 'This widget can’t be read' : 'This search can’t be shown'}: {data.message}
        </span>
      </p>
    )
  if (data.kind === 'number')
    return (
      <BigNumber
        value={data.value}
        label={
          w.dataset === 'issues'
            ? `Now, change since a ${PERIODS[range]} ago`
            : w.dataset === 'events'
              ? 'Whole UTC days, against as many before'
              : `Against the ${PERIODS[range]} before`
        }
        change={change(data.value, data.previous)}
      />
    )
  if (data.kind === 'series') {
    const byLevel = (w.groupBy ?? 'level') === 'level'
    const series = data.series.map((s, i): Series => ({
      key: `s${i}`,
      label: label(s.value),
      values: s.counts,
      color:
        s.value === null
          ? 'var(--muted-foreground)'
          : byLevel && LEVEL_COLORS[s.value]
            ? LEVEL_COLORS[s.value]
            : PALETTE[i % PALETTE.length],
    }))
    return (
      <TimeChart
        x={data.x}
        series={series}
        kind={w.display === 'area' || w.display === 'line' ? w.display : 'bar'}
        legend={series.length > 1}
        height={180}
        onSeries={(key) => {
          const value = data.series[Number(key.slice(1))]?.value ?? null
          if (filterable(value)) pick(value)
        }}
      />
    )
  }
  if (data.kind === 'table') {
    if (!data.rows.length) return <p className="py-6 text-center text-sm text-muted-foreground">Nothing matches.</p>
    const total = data.rows.reduce((a, r) => a + r.count, 0)
    const field = w.groupBy ?? 'level'
    return (
      <table className="w-full table-fixed text-xs tabular-nums">
        <thead className="text-muted-foreground">
          <tr className="border-b">
            <th className="py-1.5 text-left font-mono font-normal">{field}</th>
            <th className="w-16 py-1.5 text-right font-normal">{w.dataset === 'logs' ? 'Logs' : 'Events'}</th>
            <th className="w-14 py-1.5 text-right font-normal">Change</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => {
            const diff = change(r.count, r.previous)
            return (
              <tr key={r.value ?? '\u0000'} className="border-b last:border-0">
                <td className="truncate py-1.5 pr-2 font-mono max-sm:py-2.5">
                  {filterable(r.value) && isSearchableKey(field) ? (
                    <ValueMenu
                      field={field}
                      value={r.value}
                      onInclude={() => pick(r.value!)}
                      onExclude={() => pick(r.value!, true)}
                    >
                      {r.value}
                    </ValueMenu>
                  ) : (
                    <span className="text-muted-foreground">{label(r.value)}</span>
                  )}
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-foreground/50"
                      style={{ width: `${total > 0 ? (r.count / total) * 100 : 0}%` }}
                    />
                  </div>
                </td>
                <td className="py-1.5 text-right align-top">{count(r.count)}</td>
                <td
                  className={cn(
                    'py-1.5 text-right align-top',
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
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
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

const newId = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')

/** A widget as it's saved: a group-by only where it's shown, level (the default) as none; one redone is valid again */
function normalized(w: Widget): Widget {
  const { groupBy, invalid: _, ...rest } = w
  return groupBy && groupBy !== 'level' && w.dataset !== 'issues' && w.display !== 'number'
    ? { ...rest, groupBy }
    : rest
}

const DEBOUNCE = 400

/**
 * Adding or changing a widget: title, dataset, its search, how it's shown, what it's split by, its width, and a
 * preview (`previewWidget`) of it over the dashboard's range and project, asked for 400 ms after a change
 */
export function WidgetDialog({
  widget,
  data,
  project,
  range,
  onSave,
  onClose,
}: {
  widget?: Widget
  data?: WidgetData
  project?: string
  range: Range
  onSave: (widget: Widget, data?: WidgetData) => void
  onClose: () => void
}) {
  const [w, setW] = useState<Widget>(
    () => widget ?? { id: newId(), title: '', dataset: 'events', query: '', display: 'bar', width: 1 },
  )
  const set = (change: Partial<Widget>) => setW((old) => ({ ...old, ...change }))
  // The search as it stands in the bar, searched or not: Add saves it (the preview follows what was searched)
  const [typed, setTyped] = useState(w.query)
  // The title doesn't change what's shown, so typing it asks for nothing
  const shown = normalized({ ...w, title: 'Preview' })
  const key = JSON.stringify([shown, project, range])
  // The preview of the widget as it was when asked; while it's not the one asked for last, it's on its way
  const [preview, setPreview] = useState<{ key: string; data: WidgetData } | undefined>(
    widget && data ? { key, data } : undefined,
  )
  useEffect(() => {
    if (preview?.key === key) return
    let live = true
    const timer = setTimeout(() => {
      previewWidget({ data: { widget: JSON.parse(key)[0] as Widget, project, range } }).then(
        (d) => live && setPreview({ key, data: d }),
        (error: unknown) =>
          live &&
          setPreview({ key, data: { kind: 'error', message: error instanceof Error ? error.message : 'no preview' } }),
      )
    }, DEBOUNCE)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [key, preview?.key, project, range])
  const displays = DISPLAYS[w.dataset]
  const grouped = w.dataset !== 'issues' && w.display !== 'number'
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            const saved = { ...w, query: typed, title: w.title.trim() }
            const same = typed === w.query && preview?.key === key
            onSave(normalized(saved), same ? preview.data : undefined)
          }}
        >
          <DialogHeader>
            <DialogTitle>{widget ? 'Edit widget' : 'Add a widget'}</DialogTitle>
            <DialogDescription>A search, and how to show what it finds.</DialogDescription>
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
                  const dataset = v as Dataset
                  // Issues and events share the issues' search; logs have their own
                  const query = (dataset === 'logs') === (w.dataset === 'logs') ? typed : ''
                  set({
                    dataset,
                    display: DISPLAYS[dataset].includes(w.display) ? w.display : DISPLAYS[dataset][0],
                    groupBy: undefined,
                    query,
                  })
                  setTyped(query)
                }}
              >
                <SelectTrigger id="widget-dataset" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(DATASET_NAMES).map(([value, name]) => (
                    <SelectItem key={value} value={value}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Search</Label>
            <SearchBar
              key={w.dataset === 'logs' ? 'logs' : 'issues'}
              scope={w.dataset === 'logs' ? 'logs' : 'issues'}
              query={w.query}
              project={project}
              range={range}
              placeholder={w.dataset === 'logs' ? 'level:error release:1.0' : 'is:unresolved level:fatal'}
              onSearch={(query) => {
                set({ query })
                setTyped(query)
              }}
              onChange={setTyped}
            />
          </div>
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
          <div className="grid gap-4 sm:grid-cols-2">
            {grouped && (
              <div className="grid gap-2">
                <Label htmlFor="widget-group">By</Label>
                <GroupBy
                  dataset={w.dataset}
                  value={w.groupBy}
                  project={project}
                  range={range}
                  onChange={(groupBy) => set({ groupBy })}
                />
              </div>
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

/** What events or logs are split by: events by level or project; logs by a column or an attribute (asked for once) */
function GroupBy({
  dataset,
  value,
  project,
  range,
  onChange,
}: {
  dataset: Dataset
  value?: string
  project?: string
  range: Range
  onChange: (groupBy: string | undefined) => void
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
  const columns = dataset === 'logs' ? Object.keys(GROUP_COLUMNS) : ['level', 'project']
  const attributes = [...new Set([...(value && !columns.includes(value) ? [value] : []), ...keys])]
  return (
    <Select value={value ?? 'level'} onValueChange={(v) => onChange(v === 'level' ? undefined : v)} onOpenChange={load}>
      <SelectTrigger id="widget-group" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
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
