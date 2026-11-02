import { createFileRoute, Link, notFound, useNavigate, useRouter } from '@tanstack/react-router'
import { IconChartFunnel, IconDeviceFloppy, IconInfoCircle, IconPlus, IconTrash, IconX } from '@tabler/icons-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  ActionSelect,
  AnalyticsTabs,
  BreakdownSelect,
  FilterBar,
  type FilterSearch,
  FunnelSteps,
  PeriodSelect,
  readDays,
  readFilter,
  share,
  toFilter,
  valueLabel,
  openAnalyticsProject,
} from '@/components/analytics'
import { count } from '@/components/bits'
import { Empty, PageHeader, Shell } from '@/components/shell'
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
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { deleteFunnel, getFunnel, saveFunnel } from '@/fns'

type Search = FilterSearch & { project?: string; steps?: string[]; days?: number; by?: string }

export const Route = createFileRoute('/analytics/funnel')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
    steps: Array.isArray(s.steps) ? s.steps.filter((v): v is string => typeof v === 'string').slice(0, 8) : undefined,
    days: readDays(s.days),
    by: typeof s.by === 'string' && s.by ? s.by : undefined,
    ...readFilter(s),
  }),
  beforeLoad: ({ search }) => openAnalyticsProject('/analytics/funnel', search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const data = await getFunnel({
      data: { slug: deps.project, steps: deps.steps ?? [], days: deps.days ?? 30, by: deps.by, filter: toFilter(deps) },
    })
    if (!data) throw notFound()
    return data
  },
  head: () => ({ meta: [{ title: 'Funnels · Analytics · crashyard' }] }),
  component: Funnel,
})

function Funnel() {
  const { project: p, names, options, steps, saved, funnel } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const show = (next: string[]) => void navigate({ search: (s) => ({ ...s, steps: next }) })
  const first = funnel?.steps[0]
  const last = funnel?.steps.at(-1)
  const dropped = funnel?.steps.reduce((n, s) => n + s.dropped, 0) ?? 0
  const erred = funnel?.steps.reduce((n, s) => n + s.droppedWithError, 0) ?? 0
  const current = saved.find((f) => f.steps.join('\n') === steps.join('\n'))
  return (
    <Shell crumbs={p ? [<Link to="/analytics/funnel">Analytics</Link>, p.name] : ['Analytics']}>
      <PageHeader
        title="Funnels"
        actions={
          <PeriodSelect
            days={search.days ?? 30}
            onChange={(v) => void navigate({ search: (s) => ({ ...s, days: v === 30 ? undefined : v }) })}
          />
        }
      >
        {p?.name}
      </PageHeader>
      <AnalyticsTabs at="/analytics/funnel" search={search} />
      <FilterBar
        options={options}
        search={search}
        onChange={(f) => void navigate({ search: (s) => ({ ...s, ...f }) })}
      />
      {names.length < 2 ? (
        <Empty icon={IconChartFunnel} title="Not enough actions for a funnel">
          A funnel needs two actions or more. Once your app sends them, pick the steps people take in order here.
        </Empty>
      ) : (
        <>
          {saved.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Select
                value={current ? String(current.id) : ''}
                onValueChange={(id) => {
                  const f = saved.find((x) => String(x.id) === id)
                  if (f) show(f.steps)
                }}
              >
                <SelectTrigger className="h-10 w-60 min-w-0" aria-label="Saved funnels">
                  <SelectValue placeholder="Open a saved funnel" />
                </SelectTrigger>
                <SelectContent>
                  {saved.map((f) => (
                    <SelectItem key={f.id} value={String(f.id)}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {current && (
                <Button
                  variant="ghost"
                  className="h-10"
                  onClick={async () => {
                    if (
                      !confirm(`Delete “${current.name}”? Its steps are lost, the actions stay. This can’t be undone.`)
                    )
                      return
                    try {
                      await deleteFunnel({ data: { slug: p!.slug, id: current.id } })
                      toast.success('Funnel deleted')
                      await router.invalidate()
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : 'The funnel couldn’t be deleted')
                    }
                  }}
                >
                  <IconTrash />
                  Delete funnel
                </Button>
              )}
            </div>
          )}
          <Builder key={steps.join('\n')} names={names} steps={steps} onShow={show} onSave={() => setSaving(true)} />
          {!funnel ? (
            <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              Pick the steps in the order people take them, then Show funnel.
            </p>
          ) : (
            <>
              <p className="mb-4 flex items-start gap-2 text-sm text-muted-foreground">
                <IconInfoCircle className="mt-0.5 size-4 shrink-0" />
                Only actions that name their user count, each step within a day of the one before.
                {funnel.partial && ' This period has more than 200,000 of these actions, so only the first are read.'}
              </p>
              {first && last && (
                <dl className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
                  {[
                    ['Started', count(first.users)],
                    ['Finished', count(last.users)],
                    ['Conversion', share(last.ofFirst)],
                    ['Stopped after an error', dropped ? share(erred / dropped) : '–'],
                  ].map(([label, value]) => (
                    <div key={label} className="min-w-0 rounded-xl border p-3">
                      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
                      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <FunnelSteps steps={funnel.steps} />
              <section className="mt-6">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-medium">Conversion by group</h2>
                  <BreakdownSelect
                    value={search.by}
                    onChange={(by) => void navigate({ search: (s) => ({ ...s, by }) })}
                    properties={options.properties}
                    label="Conversion by"
                    none="Pick a breakdown"
                  />
                </div>
                {search.by && funnel.groups.length > 0 ? (
                  <div className="overflow-x-auto rounded-xl border">
                    <table className="w-full text-sm tabular-nums">
                      <thead className="text-xs text-muted-foreground">
                        <tr className="border-b">
                          <th className="px-4 py-2 text-left font-medium">Group</th>
                          <th className="px-3 py-2 text-right font-medium">Started</th>
                          <th className="px-3 py-2 text-right font-medium">Finished</th>
                          <th className="px-4 py-2 text-right font-medium">Conversion</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {funnel.groups.map((g) => (
                          <tr key={g.value}>
                            <td className="max-w-0 truncate px-4 py-2.5 font-mono text-xs">
                              {valueLabel(search.by!.replace(/^prop:/, ''), g.value)}
                            </td>
                            <td className="px-3 py-2.5 text-right">{count(g.started)}</td>
                            <td className="px-3 py-2.5 text-right">{count(g.finished)}</td>
                            <td className="px-4 py-2.5">
                              <span className="flex items-center justify-end gap-2">
                                <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted max-sm:hidden">
                                  <span
                                    className="block h-full rounded-full"
                                    style={{ width: `${g.conversion * 100}%`, background: 'var(--chart-1)' }}
                                  />
                                </span>
                                <span className="w-10 text-right font-medium">{share(g.conversion)}</span>
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Compare how releases, platforms or a property convert, each user by their group at the first step.
                  </p>
                )}
              </section>
            </>
          )}
        </>
      )}
      {saving && p && (
        <SaveDialog
          onClose={() => setSaving(false)}
          onSave={async (name) => {
            await saveFunnel({ data: { slug: p.slug, name, steps } })
            toast.success(`Saved ${name}`)
            setSaving(false)
            await router.invalidate()
          }}
        />
      )}
    </Shell>
  )
}

/** The steps, a select each, Remove past two, Add step; Show funnel applies them, Save funnel keeps them */
function Builder({
  names,
  steps,
  onShow,
  onSave,
}: {
  names: string[]
  steps: string[]
  onShow: (steps: string[]) => void
  onSave: () => void
}) {
  const [draft, setDraft] = useState(steps.length >= 2 ? steps : names.slice(0, 2))
  const changed = draft.join('\n') !== steps.join('\n')
  return (
    <section aria-label="Steps" className="mb-5 rounded-xl border p-3">
      <p className="mb-2 text-sm text-muted-foreground">Users who did each action in this order.</p>
      <ol className="flex flex-wrap items-center gap-2">
        {draft.map((step, i) => (
          <li key={i} className="flex min-w-0 items-center gap-1 max-sm:w-full">
            <span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{i + 1}</span>
            <ActionSelect
              names={names}
              value={step}
              label={`Step ${i + 1}`}
              className="w-52 max-sm:flex-1"
              onChange={(v) => v && setDraft(draft.map((s, j) => (j === i ? v : s)))}
            />
            {draft.length > 2 && (
              <Button
                variant="ghost"
                size="icon"
                className="size-10"
                aria-label={`Remove step ${i + 1}`}
                onClick={() => setDraft(draft.filter((_, j) => j !== i))}
              >
                <IconX />
              </Button>
            )}
          </li>
        ))}
        {draft.length < 8 && (
          <li>
            <Button
              variant="outline"
              className="h-10"
              onClick={() => setDraft([...draft, names.find((n) => !draft.includes(n)) ?? names[0]])}
            >
              <IconPlus />
              Add step
            </Button>
          </li>
        )}
      </ol>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button className="h-10" disabled={!changed} onClick={() => onShow(draft)}>
          Show funnel
        </Button>
        <Button variant="outline" className="h-10" disabled={changed || steps.length < 2} onClick={onSave}>
          <IconDeviceFloppy />
          Save funnel
        </Button>
      </div>
    </section>
  )
}

function SaveDialog({ onClose, onSave }: { onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            try {
              await onSave(name.trim() || 'Funnel')
            } catch (error) {
              toast.error(error instanceof Error ? error.message : 'The funnel couldn’t be saved')
              setBusy(false)
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Save funnel</DialogTitle>
            <DialogDescription>Everyone on this crashyard can open it from Funnels.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="funnel-name">Name</Label>
            <Input
              id="funnel-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Export"
              maxLength={80}
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Save funnel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
