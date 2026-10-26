import { createFileRoute, notFound, useNavigate, useRouter, Link } from '@tanstack/react-router'
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Ago } from '@/components/bits'
import { Empty, PageHeader, Shell, useProjects } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { WidgetActions, WidgetCard, WidgetDialog } from '@/components/widget'
import { MAX_WIDGETS, type Widget, type WidgetData } from '@/data/dashboards'
import type { Range } from '@/data/logs'
import { deleteDashboard, getDashboard, saveDashboard } from '@/fns'

// The same ranges as the logs page
const RANGES: Record<Range, string> = { '1h': 'Last hour', '24h': 'Last day', '7d': 'Last week', '30d': 'Last 30 days' }
type Search = { project?: string; range?: Range; edit?: boolean }

export const Route = createFileRoute('/dashboards/$dashboardId')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
    range: typeof s.range === 'string' && s.range in RANGES && s.range !== '24h' ? (s.range as Range) : undefined,
    // A new dashboard opens in edit mode
    edit: s.edit === true || s.edit === 'true' ? true : undefined,
  }),
  loaderDeps: ({ search }) => ({ project: search.project, range: search.range }),
  loader: async ({ params, deps }) => {
    if (!/^\d{1,15}$/.test(params.dashboardId)) throw notFound()
    const d = await getDashboard({
      data: { id: Number(params.dashboardId), project: deps.project, range: deps.range ?? '24h' },
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

function Board() {
  const { dashboard, data, now } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const router = useRouter()
  const project = useProjects().find((p) => p.slug === search.project)
  const range = search.range ?? '24h'
  // While editing, the dashboard as it will be saved; null when it's only shown
  const [draft, setDraft] = useState<Draft | null>(() =>
    search.edit ? { name: dashboard.name, widgets: dashboard.widgets } : null,
  )
  // What a widget added or changed in edit mode shows (its preview), until the dashboard is saved
  const [previews, setPreviews] = useState<Record<string, WidgetData | undefined>>({})
  const [dialog, setDialog] = useState<{ widget?: Widget } | null>(null)
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
      toast.error(error instanceof Error ? error.message : 'The dashboard could not be saved')
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!confirm(`Delete ${dashboard.name}? Its widgets go with it.`)) return
    setBusy(true)
    try {
      await deleteDashboard({ data: { id: dashboard.id } })
      await navigate({ to: '/dashboards', search: { project: search.project } })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The dashboard could not be deleted')
      setBusy(false)
    }
  }
  const change = (f: (widgets: Widget[]) => Widget[]) => setDraft((d) => d && { ...d, widgets: f(d.widgets) })
  const move = (i: number, by: number) =>
    change((list) => {
      const next = [...list]
      ;[next[i], next[i + by]] = [next[i + by], next[i]]
      return next
    })

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
              onValueChange={(v) =>
                void navigate({ search: (s) => ({ ...s, range: v === '24h' ? undefined : (v as Range) }) })
              }
            >
              <SelectTrigger className="w-40" aria-label="Time range" title={draft ? 'Save first' : undefined}>
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
                  Save
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setDraft({ name: dashboard.name, widgets: dashboard.widgets })}>
                <IconPencil data-icon="inline-start" />
                Edit
              </Button>
            )}
          </>
        }
      >
        {project && <>{project.name} · </>}
        Saved <Ago at={dashboard.updated} now={now} /> by {dashboard.updated_by}
      </PageHeader>

      {widgets.length === 0 ? (
        <Empty title="No widgets yet">
          <p className="mb-4">Each is a search over issues, their events or logs, as a number, a chart or a table.</p>
          {draft ? (
            <Button onClick={() => setDialog({})}>
              <IconPlus data-icon="inline-start" />
              Add widget
            </Button>
          ) : (
            <Button onClick={() => setDraft({ name: dashboard.name, widgets: [] })}>
              <IconPencil data-icon="inline-start" />
              Edit
            </Button>
          )}
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
              actions={
                draft && (
                  <WidgetActions
                    title={w.title}
                    onEdit={() => setDialog({ widget: w })}
                    onUp={i > 0 ? () => move(i, -1) : undefined}
                    onDown={i < widgets.length - 1 ? () => move(i, 1) : undefined}
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
    </Shell>
  )
}
