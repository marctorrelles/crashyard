import { createFileRoute, Link } from '@tanstack/react-router'
import { IconApps } from '@tabler/icons-react'
import { incidentReason } from '@/components/beats'
import { Ago, count, Level, percent, Sparkline } from '@/components/bits'
import { BarList, BigNumber, PALETTE, TimeChart } from '@/components/charts'
import { NewProject, PLATFORM_NAMES } from '@/components/new-project'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { change } from '@/data/charts'
import { getOverview, getOverviewCharts } from '@/fns'

export const Route = createFileRoute('/')({
  // The sidebar's project filter: every project's cards, failing monitors and new issues, or one's
  validateSearch: (s: Record<string, unknown>): { project?: string } => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
  }),
  loaderDeps: ({ search }) => ({ project: search.project }),
  loader: async ({ deps }) => {
    const [overview, charts] = await Promise.all([getOverview(), getOverviewCharts({ data: deps })])
    return { ...overview, charts, now: Date.now() }
  },
  component: Home,
})

function Home() {
  const data = Route.useLoaderData()
  const { project } = Route.useSearch()
  const { update, now } = data
  const only = <T,>(list: T[], slug: (t: T) => string) => (project ? list.filter((t) => slug(t) === project) : list)
  const projects = only(data.projects, (p) => p.slug)
  const newIssues = only(data.newIssues, (i) => i.project)
  const failing = only(data.failing, (m) => m.project_slug)
  const { charts } = data
  const name = project && (data.projects.find((p) => p.slug === project)?.name ?? project)
  const daily = charts.days.map((_, i) => charts.events.reduce((a, s) => a + s.counts[i], 0))
  // Yesterday, a whole UTC day (today's is still filling), against the day before
  const yesterday = daily.at(-2) ?? 0
  const dayBefore = daily.at(-3) ?? 0
  return (
    <Shell crumbs={name ? [<Link to="/">Overview</Link>, name] : ['Overview']}>
      <PageHeader title="Overview" actions={projects.length > 0 && <NewProject variant="outline" />} />
      {update && (
        <p className="mb-4 rounded-xl border bg-muted/40 px-4 py-2.5 text-sm">
          crashyard {update.version} is available. You’re on {update.current}.{' '}
          <a href={update.url} className="font-medium underline underline-offset-2">
            See what’s new
          </a>{' '}
          or{' '}
          <a
            href="https://github.com/marctorrelles/crashyard/blob/main/docs/upgrading.md"
            className="font-medium underline underline-offset-2"
          >
            how to upgrade
          </a>
          .
        </p>
      )}
      {projects.length === 0 ? (
        <Empty icon={IconApps} title="No projects yet" action={<NewProject />}>
          Create a project for each app, then give its Sentry SDK the DSN. Crashes start arriving on the next launch.
        </Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Link
              key={p.id}
              to="/issues"
              search={{ project: p.slug }}
              className="group rounded-xl border bg-card p-4 transition-colors hover:border-foreground/20"
            >
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="truncate font-medium">{p.name}</h2>
                <span className="shrink-0 text-xs text-muted-foreground">{PLATFORM_NAMES[p.platform]}</span>
              </div>
              <div className="mt-3 flex items-end justify-between gap-3">
                <dl className="flex gap-5 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Unresolved</dt>
                    <dd className="text-lg font-semibold tabular-nums">{count(p.unresolved)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Events in 24h</dt>
                    <dd className="text-lg font-semibold tabular-nums">{count(p.today)}</dd>
                  </div>
                </dl>
                <Sparkline values={p.series} className="h-8 w-28" />
              </div>
            </Link>
          ))}
        </div>
      )}
      {projects.length > 0 && (
        <section className="mt-8 grid gap-3" aria-label="The last 30 days">
          <div className="grid grid-cols-2 gap-3 rounded-xl border p-4 sm:grid-cols-4">
            <BigNumber label="Events yesterday" value={yesterday} change={change(yesterday, dayBefore)} />
            <BigNumber label="Unresolved" value={projects.reduce((a, p) => a + p.unresolved, 0)} />
            <BigNumber label="New issues in 24h" value={charts.newRecent} />
            <BigNumber label="Failing monitors" value={failing.length} />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border p-3 pb-1">
              <h2 className="mb-2 text-sm font-medium">Events per day</h2>
              <TimeChart
                x={charts.days}
                kind="area"
                legend={charts.events.length > 1}
                series={charts.events.map((s, i) => ({
                  key: `p${i}`,
                  label: s.name,
                  values: s.counts,
                  color: s.project === null ? 'var(--muted-foreground)' : PALETTE[i % PALETTE.length],
                }))}
                height={180}
              />
            </div>
            <div className="rounded-xl border p-3 pb-1">
              <h2 className="mb-2 text-sm font-medium">New and resolved issues</h2>
              <TimeChart
                x={charts.days}
                stacked={false}
                legend
                series={[
                  { key: 'new', label: 'New', values: charts.newIssues, color: 'var(--color-red-500)' },
                  { key: 'resolved', label: 'Resolved', values: charts.resolved, color: 'var(--color-emerald-500)' },
                ]}
                height={180}
              />
            </div>
          </div>
          {charts.crashFree.length > 0 && (
            <div className="rounded-xl border p-4">
              <h2 className="mb-2 text-sm font-medium">Crash-free sessions in the latest releases</h2>
              <BarList
                items={charts.crashFree.map((c) => ({
                  value: project ? c.release : `${c.project} ${c.release}`,
                  count: c.value,
                }))}
                total={1}
                format={percent}
              />
            </div>
          )}
        </section>
      )}
      {failing.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">Failing monitors</h2>
          <ul className="divide-y rounded-xl border border-red-500/30">
            {failing.map((m) => (
              <li key={m.id}>
                <Link
                  to="/monitors/$monitorId"
                  params={{ monitorId: String(m.id) }}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50"
                >
                  <span className="size-2 shrink-0 rounded-full bg-red-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{m.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {m.project} · {m.reason && incidentReason(m.reason)}
                    </p>
                  </div>
                  {m.since && <Ago at={m.since} now={now} className="text-xs text-muted-foreground" />}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {newIssues.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">New in the last 24 hours</h2>
          <ul className="divide-y rounded-xl border">
            {newIssues.map((i) => (
              <li key={i.id}>
                <Link
                  to="/issues/$issueId"
                  params={{ issueId: String(i.id) }}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50"
                >
                  <Level level={i.level} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{i.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {i.project} · {i.culprit || 'Unknown location'}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-xs text-muted-foreground">
                    <p className="tabular-nums">
                      {count(i.count)} {i.count === 1 ? 'event' : 'events'}
                    </p>
                    <Ago at={i.first_seen} now={now} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Shell>
  )
}
