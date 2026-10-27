import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { IconLayoutDashboard, IconPlus } from '@tabler/icons-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Ago } from '@/components/bits'
import { Empty, PageHeader, Shell, useProjects } from '@/components/shell'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { STARTER, TEMPLATES } from '@/data/templates'
import type { Widget } from '@/data/widgets'
import { getDashboards, saveDashboard } from '@/fns'

export const Route = createFileRoute('/dashboards/')({
  // The sidebar's project filter, kept for the dashboard opened from here
  validateSearch: (s: Record<string, unknown>): { project?: string } => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
  }),
  loader: () => getDashboards(),
  head: () => ({ meta: [{ title: 'Dashboards · crashyard' }] }),
  component: Dashboards,
})

function Dashboards() {
  const { dashboards, now } = Route.useLoaderData()
  const { project } = Route.useSearch()
  const name = useProjects().find((p) => p.slug === project)?.name ?? project
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  // A blank dashboard opens in edit mode; one from a template as it is
  const create = async (d: { name: string; widgets: Widget[] }, edit: boolean) => {
    setBusy(true)
    try {
      const id = await saveDashboard({ data: d })
      await navigate({
        to: '/dashboards/$dashboardId',
        params: { dashboardId: String(id) },
        search: { project, edit: edit || undefined },
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The dashboard couldn’t be created')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Shell crumbs={name ? [<Link to="/dashboards">Dashboards</Link>, name] : ['Dashboards']}>
      <PageHeader title="Dashboards" actions={dashboards.length > 0 && <NewDashboard busy={busy} onCreate={create} />}>
        Charts and numbers built from issues, events, logs, transactions, sessions and monitors. Everyone on the team
        sees the same dashboards.
      </PageHeader>
      {dashboards.length === 0 ? (
        <Empty
          icon={IconLayoutDashboard}
          title="No dashboards yet"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button disabled={busy} onClick={() => create(STARTER, false)}>
                <IconLayoutDashboard data-icon="inline-start" />
                Use the Crashes template
              </Button>
              <NewDashboard variant="outline" busy={busy} onCreate={create} />
            </div>
          }
        >
          The Crashes template shows events over time, events by level, the top unresolved issues and log errors by
          release. You can change all of it.
        </Empty>
      ) : (
        <ul className="divide-y rounded-xl border">
          {dashboards.map((d) => (
            <li key={d.id}>
              <Link
                to="/dashboards/$dashboardId"
                params={{ dashboardId: String(d.id) }}
                search={{ project }}
                className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50"
              >
                <IconLayoutDashboard className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{d.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {d.widgets === null
                      ? 'Some widgets can’t be read'
                      : `${d.widgets} ${d.widgets === 1 ? 'widget' : 'widgets'}`}{' '}
                    · {d.updated_by}
                  </p>
                </div>
                <Ago at={d.updated} now={now} className="shrink-0 text-xs text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  )
}

/** "Create dashboard": a name and a template to start from, or a blank one that opens in edit mode */
function NewDashboard({
  variant = 'default',
  busy,
  onCreate,
}: {
  variant?: 'default' | 'outline'
  busy: boolean
  onCreate: (d: { name: string; widgets: Widget[] }, edit: boolean) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [template, setTemplate] = useState('blank')
  const [name, setName] = useState('')
  const picked = TEMPLATES.find((t) => t.key === template)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant}>
          <IconPlus data-icon="inline-start" />
          Create dashboard
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            void onCreate({ name: name.trim() || picked?.name || 'Dashboard', widgets: picked?.widgets ?? [] }, !picked)
          }}
        >
          <DialogHeader>
            <DialogTitle>Create dashboard</DialogTitle>
            <DialogDescription>Start from a template or from nothing. You can change all of it.</DialogDescription>
          </DialogHeader>
          <RadioGroup value={template} onValueChange={setTemplate} aria-label="Template" className="gap-2">
            {[
              { key: 'blank', name: 'Blank', description: 'No widgets yet. It opens ready to add them.' },
              ...TEMPLATES,
            ].map((t) => (
              <Label
                key={t.key}
                htmlFor={`template-${t.key}`}
                className="flex cursor-pointer items-start gap-3 rounded-xl border p-3 font-normal has-data-[state=checked]:border-primary has-data-[state=checked]:bg-muted/50"
              >
                <RadioGroupItem id={`template-${t.key}`} value={t.key} className="mt-0.5" />
                <span className="grid gap-0.5">
                  <span className="text-sm font-medium">{t.name}</span>
                  <span className="text-xs text-muted-foreground">{t.description}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>
          <div className="grid gap-2">
            <Label htmlFor="dashboard-name">Name</Label>
            <Input
              id="dashboard-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required={!picked}
              maxLength={80}
              placeholder={picked?.name ?? 'Releases'}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              Create dashboard
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
