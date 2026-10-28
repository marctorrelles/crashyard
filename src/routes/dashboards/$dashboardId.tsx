import { createFileRoute, notFound, useNavigate, useRouter, Link } from '@tanstack/react-router'
import {
  IconChartBar,
  IconCopy,
  IconHistory,
  IconLoader2,
  IconPencil,
  IconPlus,
  IconTrash,
  IconX,
} from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Ago } from '@/components/bits'
import { SearchBar } from '@/components/search-bar'
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
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { WidgetActions, WidgetCard, WidgetDialog, WidgetViewer } from '@/components/widget'
import type { Range } from '@/data/logs'
import { MAX_WIDGETS, type Widget, type WidgetData } from '@/data/widgets'
import { deleteDashboard, getDashboard, getDashboardHistory, restoreDashboard, saveDashboard } from '@/fns'

// The same ranges as the logs page
const RANGES: Record<Range, string> = {
  '1h': 'Last hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
}
// The filter bar is in the URL: `environment`, `release` and `filter`, a search laid over every widget that knows its keys
type Search = {
  project?: string
  range?: Range
  edit?: boolean
  environment?: string
  release?: string
  filter?: string
}
const str = (v: unknown, max: number) => (typeof v === 'string' && v && v.length <= max ? v : undefined)

export const Route = createFileRoute('/dashboards/$dashboardId')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: str(s.project, 60),
    range: typeof s.range === 'string' && s.range in RANGES && s.range !== '24h' ? (s.range as Range) : undefined,
    // A new dashboard opens in edit mode
    edit: s.edit === true || s.edit === 'true' ? true : undefined,
    environment: str(s.environment, 200),
    release: str(s.release, 200),
    filter: str(s.filter, 1000),
  }),
  loaderDeps: ({ search: { edit: _, ...deps } }) => deps,
  loader: async ({ params, deps }) => {
    if (!/^\d{1,15}$/.test(params.dashboardId)) throw notFound()
    const d = await getDashboard({
      data: {
        id: Number(params.dashboardId),
        project: deps.project,
        range: deps.range ?? '24h',
        environment: deps.environment,
        release: deps.release,
        filter: deps.filter,
      },
    })
    if (!d) throw notFound()
    return d
  },
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.dashboard.name ?? 'Dashboard'} · crashyard` }] }),
  component: DashboardPage,
})

// A dashboard's own state (what's being edited) starts again when another one opens
function DashboardPage() {
  const { dashboard } = Route.useLoaderData()
  return <Board key={dashboard.id} />
}

type Draft = { name: string; widgets: Widget[] }
const newId = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')

function Board() {
  const { dashboard, data, options, now } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const router = useRouter()
  const project = useProjects().find((p) => p.slug === search.project)
  const range = search.range ?? '24h'
  const filters = { environment: search.environment, release: search.release, query: search.filter }
  // While editing, the dashboard as it will be saved; null when it's only shown
  const [draft, setDraft] = useState<Draft | null>(() =>
    search.edit ? { name: dashboard.name, widgets: dashboard.widgets } : null,
  )
  // What a widget added or changed in edit mode shows (its preview), until the dashboard is saved
  const [previews, setPreviews] = useState<Record<string, WidgetData | undefined>>({})
  const [dialog, setDialog] = useState<{ widget?: Widget } | null>(null)
  const [open, setOpen] = useState<Widget | null>(null)
  const [history, setHistory] = useState(false)
  const [dragged, setDragged] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const widgets = draft?.widgets ?? dashboard.widgets
  const dataOf = (w: Widget) => (Object.hasOwn(previews, w.id) ? previews[w.id] : data[w.id])

  const done = () => {
    setDraft(null)
    setPreviews({})
    if (search.edit) void navigate({ search: (s) => ({ ...s, edit: undefined }) })
  }
  const save = async () => {
    if (!draft) return
    setBusy(true)
    try {
      await saveDashboard({ data: { id: dashboard.id, name: draft.name, widgets: draft.widgets } })
      await router.invalidate()
      done()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The dashboard couldn’t be saved')
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!confirm(`Delete ${dashboard.name} and all its widgets? This can’t be undone.`)) return
    setBusy(true)
    try {
      await deleteDashboard({ data: { id: dashboard.id } })
      await navigate({ to: '/dashboards', search: { project: search.project } })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The dashboard couldn’t be deleted')
      setBusy(false)
    }
  }
  const duplicate = async () => {
    setBusy(true)
    try {
      const id = await saveDashboard({
        data: { name: `Copy of ${dashboard.name}`.slice(0, 80), widgets: dashboard.widgets },
      })
      toast.success(`Duplicated ${dashboard.name}`)
      await navigate({
        to: '/dashboards/$dashboardId',
        params: { dashboardId: String(id) },
        search: { project: search.project },
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The dashboard couldn’t be duplicated')
    } finally {
      setBusy(false)
    }
  }
  const change = (f: (widgets: Widget[]) => Widget[]) => setDraft((d) => d && { ...d, widgets: f(d.widgets) })
  const moveTo = (from: number, to: number) =>
    change((list) => {
      const next = [...list]
      const [w] = next.splice(from, 1)
      next.splice(to, 0, w)
      return next
    })
  const filter = (change: Partial<Search>) => void navigate({ search: (s) => ({ ...s, ...change }) })

  return (
    <Shell
      wide
      crumbs={[
        <Link to="/dashboards" search={{ project: search.project }}>
          Dashboards
        </Link>,
        dashboard.name,
      ]}
    >
      <PageHeader
        title={
          draft ? (
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              maxLength={80}
              aria-label="Name"
              className="h-9 w-72 max-w-full text-base font-semibold"
            />
          ) : (
            dashboard.name
          )
        }
        actions={
          <>
            <Select
              value={range}
              disabled={!!draft}
              onValueChange={(v) => filter({ range: v === '24h' ? undefined : (v as Range) })}
            >
              <SelectTrigger
                className="w-40"
                aria-label="Time range"
                title={draft ? 'Save or cancel your changes to change the range' : undefined}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {Object.entries(RANGES).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {draft ? (
              <>
                <Button variant="outline" onClick={() => setDialog({})} disabled={widgets.length >= MAX_WIDGETS}>
                  <IconPlus data-icon="inline-start" />
                  Add widget
                </Button>
                <Button variant="ghost" size="icon" aria-label="Delete dashboard" onClick={remove} disabled={busy}>
                  <IconTrash />
                </Button>
                <Button variant="outline" onClick={done} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={save} disabled={busy || !draft.name.trim()}>
                  Save dashboard
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="History"
                  title="History"
                  onClick={() => setHistory(true)}
                >
                  <IconHistory />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Duplicate dashboard"
                  title="Duplicate dashboard"
                  onClick={duplicate}
                  disabled={busy}
                >
                  <IconCopy />
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setDraft({ name: dashboard.name, widgets: dashboard.widgets })}
                >
                  <IconPencil data-icon="inline-start" />
                  Edit dashboard
                </Button>
              </>
            )}
          </>
        }
      >
        {project && <>{project.name} · </>}
        Saved <Ago at={dashboard.updated} now={now} /> by {dashboard.updated_by}
      </PageHeader>

      {/* The filters stay as they are while editing, as the range does: the previews are read with them */}
      {!draft && (
        <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filters">
          <FilterSelect
            label="Environment"
            all="All environments"
            value={search.environment}
            options={options.environments}
            onChange={(environment) => filter({ environment })}
          />
          <FilterSelect
            label="Release"
            all="All releases"
            value={search.release}
            options={options.releases}
            onChange={(release) => filter({ release })}
          />
          <div className="min-w-60 flex-1">
            <SearchBar
              scope="issues"
              query={search.filter ?? ''}
              project={search.project}
              placeholder="Filter every widget: level:fatal os:iOS"
              onSearch={(q) => filter({ filter: q || undefined })}
            />
          </div>
          {(search.environment || search.release || search.filter) && (
            <Button
              variant="secondary"
              onClick={() => filter({ environment: undefined, release: undefined, filter: undefined })}
            >
              <IconX data-icon="inline-start" />
              Clear filters
            </Button>
          )}
        </div>
      )}

      {widgets.length === 0 ? (
        <Empty
          icon={IconChartBar}
          title="An empty canvas"
          action={
            draft ? (
              <Button onClick={() => setDialog({})}>
                <IconPlus data-icon="inline-start" />
                Add widget
              </Button>
            ) : (
              <Button onClick={() => setDraft({ name: dashboard.name, widgets: [] })}>
                <IconPencil data-icon="inline-start" />
                Edit dashboard
              </Button>
            )
          }
        >
          A widget reads issues, events, logs, transactions, sessions, monitors or releases and shows them as a number,
          a chart or a table.
        </Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-3">
          {widgets.map((w, i) => (
            <WidgetCard
              key={w.id}
              widget={w}
              data={dataOf(w)}
              project={search.project}
              range={range}
              onOpen={draft ? undefined : () => setOpen(w)}
              // Edit mode: drag a card onto another to move it there; the arrows do the same without a mouse
              draggable={!!draft}
              dragging={dragged === i}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                setDragged(i)
              }}
              onDragOver={(e) => draft && dragged !== null && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                if (dragged !== null && dragged !== i) moveTo(dragged, i)
                setDragged(null)
              }}
              onDragEnd={() => setDragged(null)}
              actions={
                draft && (
                  <WidgetActions
                    title={w.title}
                    onEdit={() => setDialog({ widget: w })}
                    onDuplicate={
                      widgets.length < MAX_WIDGETS
                        ? () => change((list) => [...list.slice(0, i + 1), { ...w, id: newId() }, ...list.slice(i + 1)])
                        : undefined
                    }
                    onUp={i > 0 ? () => moveTo(i, i - 1) : undefined}
                    onDown={i < widgets.length - 1 ? () => moveTo(i, i + 1) : undefined}
                    onRemove={() => change((list) => list.filter((x) => x.id !== w.id))}
                  />
                )
              }
            />
          ))}
        </div>
      )}

      {dialog && (
        <WidgetDialog
          widget={dialog.widget}
          data={dialog.widget && dataOf(dialog.widget)}
          project={search.project}
          range={range}
          filters={filters}
          onClose={() => setDialog(null)}
          onSave={(widget, shown) => {
            change((list) =>
              list.some((x) => x.id === widget.id)
                ? list.map((x) => (x.id === widget.id ? widget : x))
                : [...list, widget],
            )
            setPreviews((p) => ({ ...p, [widget.id]: shown }))
            setDialog(null)
          }}
        />
      )}
      {open && dataOf(open) && (
        <WidgetViewer
          widget={open}
          data={dataOf(open)!}
          project={search.project}
          range={range}
          onClose={() => setOpen(null)}
        />
      )}
      {history && <History id={dashboard.id} now={now} onClose={() => setHistory(false)} />}
    </Shell>
  )
}

/** An environment or release for every widget, from those events came with lately */
function FilterSelect({
  label,
  all,
  value,
  options,
  onChange,
}: {
  label: string
  all: string
  value?: string
  options: string[]
  onChange: (value: string | undefined) => void
}) {
  const list = value && !options.includes(value) ? [value, ...options] : options
  return (
    <Select value={value ?? '*'} onValueChange={(v) => onChange(v === '*' ? undefined : v)}>
      <SelectTrigger className="w-44 max-sm:flex-1" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="*">{all}</SelectItem>
        {list.map((o) => (
          <SelectItem key={o} value={o} className="font-mono">
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** The widget lists of the last 10 saves, each with who saved it, and Restore */
function History({ id, now, onClose }: { id: number; now: number; onClose: () => void }) {
  const router = useRouter()
  const [list, setList] = useState<Awaited<ReturnType<typeof getDashboardHistory>> | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    getDashboardHistory({ data: { id } }).then(
      (l) => live && setList(l),
      () => live && setList([]),
    )
    return () => {
      live = false
    }
  }, [id])
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>History</DialogTitle>
          <DialogDescription>The widgets this dashboard had before each of its last 10 saves.</DialogDescription>
        </DialogHeader>
        {list === null ? (
          <p className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
            <IconLoader2 className="size-4 shrink-0 animate-spin" />
            Loading…
          </p>
        ) : list.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Nothing yet. Each save keeps the widgets it replaced here.
          </p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {list.map((r) => (
              <li key={r.index} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    Saved <Ago at={r.at} now={now} /> by {r.by}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.widgets === null
                      ? 'Widgets that can’t be read'
                      : `${r.widgets} ${r.widgets === 1 ? 'widget' : 'widgets'}`}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="max-sm:h-10"
                  disabled={busy || r.widgets === null}
                  onClick={async () => {
                    if (!confirm('Restore this version? The widgets there now are kept in the history.')) return
                    setBusy(true)
                    try {
                      await restoreDashboard({ data: { id, index: r.index } })
                      await router.invalidate()
                      toast.success('Version restored')
                      onClose()
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : 'The widgets couldn’t be restored')
                      setBusy(false)
                    }
                  }}
                >
                  Restore version
                </Button>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
