import { createFileRoute, Link } from '@tanstack/react-router'
import { ClockIcon, GlobeIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { Ago } from '@/components/bits'
import { Beats, MonitorStatus } from '@/components/beats'
import { type Editing, MonitorForm } from '@/components/monitor-form'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { getMonitors } from '@/fns'
import { describeSchedule, type Schedule } from '@/monitors/schedule'

export const Route = createFileRoute('/monitors/')({
  loader: () => getMonitors(),
  head: () => ({ meta: [{ title: 'Monitors · crashyard' }] }),
  component: Monitors,
})

function Monitors() {
  const { monitors, projects, now } = Route.useLoaderData()
  const [editing, setEditing] = useState<Editing | null>(null)
  return (
    <Shell crumbs={['Monitors']}>
      <PageHeader
        title="Monitors"
        actions={
          projects.length > 0 && (
            <>
              <Button variant="outline" onClick={() => setEditing({ kind: 'uptime' })}>
                <PlusIcon data-icon="inline-start" />
                Uptime check
              </Button>
              <Button variant="outline" onClick={() => setEditing({ kind: 'cron' })}>
                <PlusIcon data-icon="inline-start" />
                Cron monitor
              </Button>
            </>
          )
        }
      >
        Jobs that check in, and URLs crashyard checks.
      </PageHeader>
      {monitors.length === 0 ? (
        <Empty title="No monitors yet">
          Add an uptime check for a URL, or a cron monitor; jobs that check in with a monitor config appear by
          themselves.
        </Empty>
      ) : (
        <ul className="divide-y rounded-xl border">
          {monitors.map((m) => {
            const config = JSON.parse(m.config) as { url?: string; schedule?: Schedule; intervalMinutes?: number }
            const Icon = m.kind === 'uptime' ? GlobeIcon : ClockIcon
            return (
              <li key={m.id}>
                <Link
                  to="/monitors/$monitorId"
                  params={{ monitorId: String(m.id) }}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-muted/40"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{m.name}</span>
                      <MonitorStatus status={m.status} />
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {m.project_name} ·{' '}
                      {m.kind === 'uptime'
                        ? `${config.url} · every ${config.intervalMinutes} min`
                        : describeSchedule(config.schedule!)}
                      {m.incident_since && (
                        <>
                          {' '}
                          · failing since <Ago at={m.incident_since} now={now} />
                        </>
                      )}
                      {!m.incident_since && m.last_seen && (
                        <>
                          {' '}
                          · <Ago at={m.last_seen} now={now} />
                        </>
                      )}
                    </p>
                  </div>
                  <Beats beats={m.beats} className="max-sm:w-full" />
                </Link>
              </li>
            )
          })}
        </ul>
      )}
      {editing && <MonitorForm editing={editing} projects={projects} onClose={() => setEditing(null)} />}
    </Shell>
  )
}
