import { createFileRoute, Link, notFound, useNavigate, useRouter } from '@tanstack/react-router'
import { IconPencil, IconPlayerPause, IconPlayerPlay, IconTrash } from '@tabler/icons-react'
import { useState } from 'react'
import { Ago, Level, percent } from '@/components/bits'
import { TimeChart } from '@/components/charts'
import { ms as short } from '@/components/performance'
import { Time } from '@/components/time'
import { Beats, incidentReason, MonitorStatus } from '@/components/beats'
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
              {m.status === 'paused' ? (
                <IconPlayerPlay data-icon="inline-start" />
              ) : (
                <IconPlayerPause data-icon="inline-start" />
              )}
              {m.status === 'paused' ? 'Resume' : 'Pause'}
            </Button>
            <Button variant="outline" size="icon" aria-label="Edit" onClick={() => setEditing({ ...m, config })}>
              <IconPencil />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete"
              onClick={async () => {
                if (!confirm(`Delete ${m.name} and its whole history? This can’t be undone.`)) return
                await deleteMonitor({ data: { id: m.id } })
                await navigate({ to: '/monitors' })
              }}
            >
              <IconTrash />
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

      {m.muted_at && (
        <p className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-2.5 text-sm">
          Muted <Time at={m.muted_at} /> after failing for 14 days. Alerts start again once it recovers.
        </p>
      )}
      <section className="mb-6 grid gap-3" aria-label="Uptime and timing">
        <dl className="grid grid-cols-3 gap-3">
          {(
            [
              ['24 hours', d.uptime.day],
              ['7 days', d.uptime.week],
              ['30 days', d.uptime.month],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="rounded-xl border p-3">
              <dt className="text-xs text-muted-foreground">
                {m.kind === 'uptime' ? 'Up' : 'Runs ok'} over {label}
              </dt>
              <dd className="text-lg font-semibold tabular-nums">{value === null ? '–' : percent(value)}</dd>
            </div>
          ))}
        </dl>
        {d.p95.some((p) => p.p95 !== null) && (
          <div className="rounded-xl border p-3 pb-1">
            <p className="mb-2 text-sm text-muted-foreground">
              {m.kind === 'uptime'
                ? 'Response time p95 per hour, the last 24 hours'
                : 'Run time p95 per day, the last 30 days'}
            </p>
            <TimeChart
              x={d.p95.map((p) => p.at)}
              series={[
                { key: 'p95', label: 'p95', values: d.p95.map((p) => p.p95), kind: 'line', color: 'var(--chart-1)' },
              ]}
              format={(v) => short(v)}
              className="h-32 md:h-40"
            />
          </div>
        )}
      </section>
      {d.environments.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-medium">Environments</h2>
          <ul className="divide-y rounded-xl border text-sm">
            {d.environments.map((e) => (
              <li key={e.environment} className="flex items-center gap-3 px-3 py-2">
                <span
                  className={cn(
                    'size-2 rounded-full',
                    e.status === 'ok' ? 'bg-emerald-500' : e.status === 'in_progress' ? 'bg-sky-500' : 'bg-red-500',
                  )}
                />
                <span className="flex-1 font-mono text-xs">{e.environment}</span>
                <span className="text-xs text-muted-foreground">
                  {e.status === 'in_progress' ? 'Running' : e.status === 'ok' ? 'Ok' : 'Failing'} ·{' '}
                  <Ago at={e.last_check_in} now={now} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
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
                  Late if nothing arrives by <Time at={m.next_due} />.
                </>
              ) : (
                'Paused. Nothing counts as late until you resume it.'
              )}
            </p>
          </div>
          {d.checkins.length === 0 && (
            <div className="grid gap-2">
              <p className="text-sm">Waiting for the first check-in. Send one from the job with a Sentry SDK:</p>
              <Code
                text={`const id = Sentry.captureCheckIn({ monitorSlug: '${m.slug}', status: 'in_progress' })
// … the job …
Sentry.captureCheckIn({ checkInId: id, monitorSlug: '${m.slug}', status: 'ok' })`}
              />
              <p className="text-sm">Or wrap any command with sentry-cli and the project’s DSN:</p>
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

      {m.kind === 'cron' && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-medium">Errors during this job</h2>
          {d.errors.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No errors from its runs. Errors show here when they share a check-in’s trace, as with Sentry.withMonitor.
            </p>
          ) : (
            <ul className="divide-y rounded-xl border text-sm">
              {d.errors.map((e) => (
                <li key={e.id}>
                  <Link
                    to="/issues/$issueId"
                    params={{ issueId: String(e.issue_id) }}
                    search={{ event: e.id }}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40"
                  >
                    <Level level={e.level} />
                    <span className="min-w-0 flex-1 truncate">{e.title}</span>
                    <Ago at={e.received} now={now} className="shrink-0 text-xs text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-medium">Incidents</h2>
        {d.incidents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No incidents. Smooth running so far.</p>
        ) : (
          <ul className="divide-y rounded-xl border text-sm">
            {d.incidents.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-x-3 px-3 py-2">
                <span className={cn('size-2 rounded-full', i.closed_at ? 'bg-muted-foreground/40' : 'bg-red-500')} />
                <span className="flex-1">{incidentReason(i.reason)}</span>
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
