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
import { STARTER } from '@/data/dashboards'
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
  // A new dashboard opens in edit mode; the starter one as it is
  const create = async (d: typeof STARTER, edit: boolean) => {
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
      <PageHeader
        title="Dashboards"
        actions={
          dashboards.length > 0 && <NewDashboard busy={busy} onCreate={(name) => create({ name, widgets: [] }, true)} />
        }
      >
        Charts and numbers built from issues, events and logs. Everyone on the team sees the same dashboards.
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
              <NewDashboard variant="outline" busy={busy} onCreate={(name) => create({ name, widgets: [] }, true)} />
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

/** "New dashboard": a name, then the dashboard in edit mode */
function NewDashboard({
  variant = 'default',
  busy,
  onCreate,
}: {
  variant?: 'default' | 'outline'
  busy: boolean
  onCreate: (name: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant}>
          <IconPlus data-icon="inline-start" />
          New dashboard
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            void onCreate(String(new FormData(e.currentTarget).get('name')).trim())
          }}
        >
          <DialogHeader>
            <DialogTitle>New dashboard</DialogTitle>
            <DialogDescription>Name it, then add widgets.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="dashboard-name">Name</Label>
            <Input id="dashboard-name" name="name" required maxLength={80} placeholder="Releases" autoComplete="off" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
