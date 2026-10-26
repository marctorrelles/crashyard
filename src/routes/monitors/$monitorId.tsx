import { createFileRoute, Link, notFound, useNavigate, useRouter } from '@tanstack/react-router'
import { PauseIcon, PencilIcon, PlayIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { Ago, LocalTime } from '@/components/bits'
import { Beats, MonitorStatus } from '@/components/beats'
import { Code } from '@/components/linking'
import { type Editing, MonitorForm } from '@/components/monitor-form'
import { PageHeader, Shell } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { deleteMonitor, getMonitor, pauseMonitor } from '@/fns'
import { cn } from '@/lib/utils'
import { describeSchedule, type Schedule } from '@/monitors/schedule'

export const Route = createFileRoute('/monitors/$monitorId')({
  loader: async ({ params }) => {
    const data = await getMonitor({ data: { id: Number(params.monitorId) } })
    if (!data) throw notFound()
    return data
  },
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.monitor.name ?? 'Monitor'} · crashyard` }] }),
  component: MonitorPage,
})

const duration = (ms: number) =>
  ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`

function MonitorPage() {
  const d = Route.useLoaderData()
  const { monitor: m, now } = d
  const router = useRouter()
  const navigate = useNavigate()
  const [editing, setEditing] = useState<Editing | null>(null)
  const config = JSON.parse(m.config) as Record<string, unknown> & { schedule?: Schedule; url?: string }
  const okRate = d.results.length
    ? Math.round((d.results.filter((r) => r.ok).length / d.results.length) * 1000) / 10
    : null
  const times = d.results.filter((r) => r.ms !== null).map((r) => r.ms!)
  const median = times.length ? [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)] : null
  return (
    <Shell crumbs={[<Link to="/monitors">Monitors</Link>, m.name]}>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {m.name} <MonitorStatus status={m.status} />
          </span>
        }
        actions={
          <>
            <Button
              variant="outline"
              onClick={async () => {
                await pauseMonitor({ data: { id: m.id, paused: m.status !== 'paused' } })
                await router.invalidate()
              }}
            >
              {m.status === 'paused' ? <PlayIcon data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}
              {m.status === 'paused' ? 'Resume' : 'Pause'}
            </Button>
            <Button variant="outline" size="icon" aria-label="Edit" onClick={() => setEditing({ ...m, config })}>
              <PencilIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete"
              onClick={async () => {
                if (!confirm(`Delete ${m.name} and its history?`)) return
                await deleteMonitor({ data: { id: m.id } })
                await navigate({ to: '/monitors' })
              }}
            >
              <Trash2Icon />
            </Button>
          </>
        }
      >
        {m.project_name} ·{' '}
        {m.kind === 'uptime'
          ? `${config.method ?? 'GET'} ${config.url} · every ${config.intervalMinutes} min`
          : describeSchedule(config.schedule!)}
        {m.kind === 'cron' && config.timezone ? ` (${String(config.timezone)})` : ''}
      </PageHeader>

      {m.kind === 'uptime' ? (
        <section className="mb-6 rounded-xl border p-4">
          <dl className="mb-3 grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Up</dt>
              <dd className="font-semibold tabular-nums">{okRate === null ? '—' : `${okRate}%`}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Median</dt>
              <dd className="font-semibold tabular-nums">{median === null ? '—' : duration(median)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last checked</dt>
              <dd className="font-semibold">{m.last_seen ? <Ago at={m.last_seen} now={now} /> : 'not yet'}</dd>
            </div>
          </dl>
          <Beats
            beats={[...d.results]
              .reverse()
              .slice(-30)
              .map((r) => ({ ...r, status: r.status }))}
            className="h-12"
          />
          <ul className="mt-4 max-h-80 divide-y overflow-auto rounded-xl border text-xs">
            {d.results.map((r) => (
              <li key={r.at} className="flex items-center gap-3 px-3 py-1.5">
                <span className={cn('size-2 rounded-full', r.ok ? 'bg-emerald-500' : 'bg-red-500')} />
                <Ago at={r.at} now={now} className="w-16 text-muted-foreground" />
                <span className="tabular-nums">{r.status ?? '—'}</span>
                <span className="text-muted-foreground tabular-nums">{r.ms !== null ? duration(r.ms) : ''}</span>
                {r.error && <span className="min-w-0 flex-1 truncate text-red-600 dark:text-red-400">{r.error}</span>}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="mb-6 grid gap-3">
          <div className="rounded-xl border p-4">
            <Beats
              beats={[...d.checkins]
                .reverse()
                .slice(-30)
                .map((c) => ({
                  at: c.started,
                  ok: c.status === 'ok' || c.status === 'in_progress' ? 1 : 0,
                  ms: c.duration,
                  status: c.status,
                }))}
              className="h-12"
            />
            <p className="mt-2 text-xs text-muted-foreground">
              {m.next_due && m.status !== 'paused' ? (
                <>
                  Late if nothing arrives by <LocalTime at={m.next_due} />.
                </>
              ) : (
                'Paused: nothing is late.'
              )}
            </p>
          </div>
          {d.checkins.length === 0 && (
            <div className="grid gap-2">
              <p className="text-sm">Waiting for the first check-in. From the job, with a Sentry SDK:</p>
              <Code
                text={`const id = Sentry.captureCheckIn({ monitorSlug: '${m.slug}', status: 'in_progress' })
// … the job …
Sentry.captureCheckIn({ checkInId: id, monitorSlug: '${m.slug}', status: 'ok' })`}
              />
              <p className="text-sm">Or around any command, with sentry-cli and the project’s DSN:</p>
              <Code text={`SENTRY_DSN=<the project's DSN> sentry-cli monitors run ${m.slug} -- ./backup.sh`} />
            </div>
          )}
          {d.checkins.length > 0 && (
            <ul className="max-h-80 divide-y overflow-auto rounded-xl border text-xs">
              {d.checkins.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-3 py-1.5">
                  <span
                    className={cn(
                      'size-2 rounded-full',
                      c.status === 'ok' ? 'bg-emerald-500' : c.status === 'in_progress' ? 'bg-sky-500' : 'bg-red-500',
                    )}
                  />
                  <Ago at={c.started} now={now} className="w-16 text-muted-foreground" />
                  <span>{c.status.replace('_', ' ')}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {c.duration !== null ? duration(c.duration) : ''}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
                    {[c.release, c.environment].filter(Boolean).join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-medium">Incidents</h2>
        {d.incidents.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="divide-y rounded-xl border text-sm">
            {d.incidents.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-x-3 px-3 py-2">
                <span className={cn('size-2 rounded-full', i.closed_at ? 'bg-muted-foreground/40' : 'bg-red-500')} />
                <span className="flex-1">{i.reason}</span>
                <span className="text-xs text-muted-foreground">
                  <Ago at={i.opened_at} now={now} />
                  {i.closed_at ? ` · lasted ${duration(i.closed_at - i.opened_at)}` : ' · still open'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {editing && <MonitorForm editing={editing} projects={d.projects} onClose={() => setEditing(null)} />}
    </Shell>
  )
}
