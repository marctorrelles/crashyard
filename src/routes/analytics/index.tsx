import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router'
import { IconChartFunnel, IconInfoCircle } from '@tabler/icons-react'
import {
  AnalyticsTabs,
  Breakdown,
  Change,
  FilterBar,
  type FilterSearch,
  PeriodSelect,
  readDays,
  readFilter,
  share,
  Stats,
  toFilter,
} from '@/components/analytics'
import { count, Sparkline } from '@/components/bits'
import { PALETTE, TimeChart } from '@/components/charts'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { getAnalytics } from '@/fns'

type Search = FilterSearch & { project?: string; days?: number }

export const Route = createFileRoute('/analytics/')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
    days: readDays(s.days),
    ...readFilter(s),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const data = await getAnalytics({ data: { slug: deps.project, days: deps.days ?? 30, filter: toFilter(deps) } })
    if (!data) throw notFound()
    return data
  },
  head: () => ({ meta: [{ title: 'Analytics · crashyard' }] }),
  component: Overview,
})

type Section = NonNullable<Awaited<ReturnType<typeof getAnalytics>>>['sections'][number]

function Overview() {
  const { sections, options } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const name = search.project && (sections[0]?.project.name ?? search.project)
  const shown = sections.filter((d) => d.actions > 0)
  const ever = sections.some((d) => d.ever)
  return (
    <Shell crumbs={name ? [<Link to="/analytics">Analytics</Link>, name] : ['Analytics']}>
      <PageHeader
        title="Analytics"
        actions={
          <PeriodSelect
            days={search.days ?? 30}
            onChange={(v) => void navigate({ search: (s) => ({ ...s, days: v === 30 ? undefined : v }) })}
          />
        }
      >
        {name ?? 'What people do in your apps, beside what breaks.'}
      </PageHeader>
      <AnalyticsTabs at="/analytics" search={search} />
      <FilterBar
        options={options}
        search={search}
        onChange={(f) => void navigate({ search: (s) => ({ ...s, ...f }) })}
      />
      {shown.length === 0 &&
        (ever ? (
          <Empty icon={IconChartFunnel} title="No actions in this period">
            Nothing matches this period and these filters. Try a longer period or clear the filters.
          </Empty>
        ) : (
          <Empty icon={IconChartFunnel} title="No actions yet">
            Turn on logs with <code>enableLogs: true</code> in <code>Sentry.init</code>, then send a log with{' '}
            <code>crashyard.action</code> set, such as{' '}
            <code>
              Sentry.logger.info('signed up', {'{'} 'crashyard.action': true {'}'})
            </code>
            . Set the user with <code>Sentry.setUser</code> so actions count per person and meet their errors.
          </Empty>
        ))}
      <div className="grid grid-cols-1 gap-12">
        {shown.map((d) => (
          <ProjectOverview
            key={d.project.id}
            d={d}
            days={search.days ?? 30}
            named={!search.project}
            onPick={(f) => void navigate({ search: (s) => ({ ...s, ...f }) })}
          />
        ))}
      </div>
    </Shell>
  )
}

const BREAKDOWNS = [
  ['platform', 'Platforms'],
  ['os', 'Operating systems'],
  ['country', 'Countries'],
  ['release', 'Releases'],
  ['device', 'Devices'],
] as const

function ProjectOverview({
  d,
  days,
  named,
  onPick,
}: {
  d: Section
  days: number
  named: boolean
  onPick: (f: FilterSearch) => void
}) {
  return (
    <section className="min-w-0">
      {named && <h2 className="mb-3 text-sm font-medium wrap-anywhere text-muted-foreground">{d.project.name}</h2>}
      <Stats
        stats={[
          { label: 'Active users', value: count(d.users), change: d.usersChange },
          { label: 'New users', value: count(d.newUsers), change: d.newUsersChange },
          { label: 'Actions per user', value: d.perUser === null ? '–' : d.perUser.toFixed(1) },
          {
            label: 'Users who hit an error',
            value: d.withErrors === null ? '–' : share(d.withErrors),
            hint: 'An error or a crash',
          },
        ]}
      />
      <Stats
        stats={[
          { label: 'Daily active users', value: count(d.dauNow), hint: 'Today, in UTC' },
          { label: 'Weekly active users', value: count(d.wauNow), hint: 'The last 7 days' },
          { label: 'Monthly active users', value: count(d.mauNow), hint: 'The last 30 days' },
          {
            label: 'Stickiness',
            value: d.stickiness === null ? '–' : share(d.stickiness),
            hint: 'Of the month’s users, on a day',
          },
        ]}
      />
      {d.anonymous > 0 && (
        <p className="mb-4 flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
          <IconInfoCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            {count(d.anonymous)} actions came without a user. They count as actions but not as users. Set the user with{' '}
            <code>Sentry.setUser</code> to count them.
          </span>
        </p>
      )}
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="min-w-0 rounded-xl border p-3 pb-1">
          <p className="mb-2 text-sm text-muted-foreground">Active users</p>
          <TimeChart
            x={d.days}
            series={[
              { key: 'dau', label: 'Daily', values: d.dau, kind: 'line', color: PALETTE[0] },
              { key: 'wau', label: 'Weekly', values: d.wau, kind: 'line', color: PALETTE[1] },
              { key: 'mau', label: 'Monthly', values: d.mau, kind: 'line', color: PALETTE[3] },
            ]}
            stacked={false}
            legend
            className="h-40 md:h-48"
          />
        </div>
        <div className="min-w-0 rounded-xl border p-3 pb-1">
          <p className="mb-2 text-sm text-muted-foreground">New users and sessions</p>
          <TimeChart
            x={d.days}
            series={[
              { key: 'new', label: 'New users', values: d.newPerDay, kind: 'bar', color: 'var(--chart-1)' },
              {
                key: 'sessions',
                label: 'Sessions',
                values: d.sessionsPerDay,
                kind: 'line',
                color: PALETTE[0],
                axis: 'right',
              },
            ]}
            legend
            className="h-40 md:h-48"
          />
        </div>
      </div>
      <div className="mb-6 grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
        {BREAKDOWNS.filter(([field]) => d.breakdowns[field].some((x) => x.value !== '')).map(([field, title]) => (
          <Breakdown
            key={field}
            title={title}
            field={field}
            items={d.breakdowns[field].map((x) => ({ value: x.value, count: x.users }))}
            total={d.users}
            onPick={field === 'device' ? undefined : (v) => onPick({ [field]: v })}
          />
        ))}
      </div>
      <h3 className="mb-2 text-sm font-medium">Actions</h3>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b">
              <th className="px-4 py-2 text-left font-medium">Action</th>
              <th className="px-3 py-2 text-right font-medium max-sm:hidden">
                <span className="sr-only">Over the period</span>
              </th>
              <th className="px-3 py-2 text-right font-medium">Count</th>
              <th className="px-3 py-2 text-right font-medium max-sm:pr-4">Users</th>
              <th className="px-4 py-2 text-right font-medium max-sm:hidden">Change</th>
            </tr>
          </thead>
          <tbody className="divide-y tabular-nums">
            {d.list.map((a) => (
              <tr key={a.name} className="hover:bg-muted/40">
                <td className="max-w-0 px-4 py-2.5">
                  <Link
                    to="/analytics/action"
                    search={{ project: d.project.slug, name: a.name, days: days === 30 ? undefined : days }}
                    className="block truncate font-mono text-xs font-medium hover:underline"
                  >
                    {a.name}
                  </Link>
                </td>
                <td className="px-3 py-2.5 max-sm:hidden">
                  <Sparkline values={a.trend} label="Count over the period" className="ml-auto h-5 w-24" />
                </td>
                <td className="px-3 py-2.5 text-right font-medium">{count(a.count)}</td>
                <td className="px-3 py-2.5 text-right max-sm:pr-4">{count(a.users)}</td>
                <td className="px-4 py-2.5 text-right max-sm:hidden">
                  <Change value={a.change} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
