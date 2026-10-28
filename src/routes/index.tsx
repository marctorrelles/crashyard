import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router'
import { IconApps } from '@tabler/icons-react'
import { incidentReason } from '@/components/beats'
import { Ago, count, Level, percent, Sparkline } from '@/components/bits'
import { BarList, BigNumber, PALETTE, TimeChart } from '@/components/charts'
import { NewProject } from '@/components/new-project'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CHART_DAYS, change, type ChartDays } from '@/data/charts'
import { getHome, getOverview, getOverviewCharts } from '@/fns'

const DEFAULT_DAYS = 30

export const Route = createFileRoute('/')({
  // The sidebar's project filter: every project's cards, failing monitors and new issues, or one's; the charts' days
  validateSearch: (s: Record<string, unknown>): { project?: string; days?: ChartDays } => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
    days:
      CHART_DAYS.includes(Number(s.days) as ChartDays) && Number(s.days) !== DEFAULT_DAYS
        ? (Number(s.days) as ChartDays)
        : undefined,
  }),
  // Opening crashyard (a page load of / as it is, not a click on All projects) lands on the viewer's Home settings
  beforeLoad: async ({ search }) => {
    if (typeof window !== 'undefined' || search.project || search.days) return
    const home = await getHome()
    if (home.project || (home.days && home.days !== DEFAULT_DAYS))
      throw redirect({
        to: '/',
        search: { project: home.project, days: home.days === DEFAULT_DAYS ? undefined : (home.days as ChartDays) },
      })
  },
  loaderDeps: ({ search }) => ({ project: search.project, days: search.days }),
  loader: async ({ deps }) => {
    const [overview, charts] = await Promise.all([
      getOverview(),
      getOverviewCharts({ data: { project: deps.project, days: deps.days ?? DEFAULT_DAYS } }),
    ])
    return { ...overview, charts, now: Date.now() }
  },
  component: Home,
})

function Home() {
  const data = Route.useLoaderData()
  const { project, days } = Route.useSearch()
  const navigate = useNavigate()
  const { now } = data
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
              {p.newest && (
                <p className="mt-3 truncate text-xs text-muted-foreground">
                  <span className="font-mono">{p.newest.release}</span> on {percent(p.newest.adoption)} of sessions
                </p>
              )}
            </Link>
          ))}
        </div>
      )}
      {projects.length > 0 && (
        <section className="mt-8 grid gap-3" aria-label={`The last ${charts.days.length} days`}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium">The last {charts.days.length} days</h2>
            <Select
              value={String(days ?? DEFAULT_DAYS)}
              onValueChange={(v) =>
                void navigate({
                  to: '/',
                  search: (s) => ({ ...s, days: Number(v) === DEFAULT_DAYS ? undefined : (Number(v) as ChartDays) }),
                })
              }
            >
              <SelectTrigger size="sm" className="w-32" aria-label="Period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {CHART_DAYS.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
