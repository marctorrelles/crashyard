import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router'
import { IconChartFunnel } from '@tabler/icons-react'
import { AnalyticsTabs, Change, share, Stats } from '@/components/analytics'
import { count, Sparkline } from '@/components/bits'
import { TimeChart } from '@/components/charts'
import { Period } from '@/components/performance'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { getAnalytics } from '@/fns'

type Search = { project?: string; days?: number }

export const Route = createFileRoute('/analytics/')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
    days: [1, 30].includes(Number(s.days)) ? Number(s.days) : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const data = await getAnalytics({ data: { slug: deps.project, days: deps.days ?? 7 } })
    if (!data) throw notFound()
    return data
  },
  head: () => ({ meta: [{ title: 'Analytics · crashyard' }] }),
  component: Analytics,
})

type Section = NonNullable<Awaited<ReturnType<typeof getAnalytics>>>[number]

function Analytics() {
  const sections = Route.useLoaderData()
  const { project, days } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const name = project && (sections[0]?.project.name ?? project)
  const shown = sections.filter((d) => d.actions > 0)
  return (
    <Shell crumbs={name ? [<Link to="/analytics">Analytics</Link>, name] : ['Analytics']}>
      <PageHeader
        title="Analytics"
        actions={
          <Period
            days={days ?? 7}
            onChange={(v) => void navigate({ search: (s) => ({ ...s, days: v === 7 ? undefined : v }) })}
          />
        }
      >
        {name ?? 'What people do in your apps, beside what breaks.'}
      </PageHeader>
      <AnalyticsTabs at="/analytics" project={project} />
      {shown.length === 0 && (
        <Empty icon={IconChartFunnel} title="No actions yet">
          Send an action with the Sentry SDK your app already has: a log with <code>crashyard.action</code> set, such as{' '}
          <code>
            Sentry.logger.info('signed up', {'{'} 'crashyard.action': true {'}'})
          </code>
          . Actions then appear here with the people who did them.
        </Empty>
      )}
      <div className="grid grid-cols-1 gap-10">
        {shown.map((d) => (
          <ProjectActions key={d.project.id} d={d} days={days ?? 7} named={!project} />
        ))}
      </div>
    </Shell>
  )
}

function ProjectActions({ d, days, named }: { d: Section; days: number; named: boolean }) {
  return (
    <section className="min-w-0">
      {named && <h2 className="mb-3 text-sm font-medium wrap-anywhere text-muted-foreground">{d.project.name}</h2>}
      <Stats
        stats={[
          { label: 'Active users', value: count(d.users), change: d.usersChange },
          { label: 'Actions', value: count(d.actions), change: d.actionsChange },
          { label: 'Actions per user', value: d.perUser === null ? '–' : d.perUser.toFixed(1) },
          {
            label: 'Users who hit an error',
            value: d.withErrors === null ? '–' : share(d.withErrors),
          },
        ]}
      />
      <div className="mb-5 rounded-xl border p-3 pb-1">
        <p className="mb-2 text-sm text-muted-foreground">Active users</p>
        <TimeChart
          x={d.steps}
          series={[
            { key: 'users', label: 'Active users', values: d.activeUsers, kind: 'area', color: 'var(--chart-1)' },
          ]}
          className="h-32 md:h-44"
        />
      </div>
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
                    search={{ project: d.project.slug, name: a.name, days: days === 7 ? undefined : days }}
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
