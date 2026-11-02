import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { IconRepeat } from '@tabler/icons-react'
import { AnalyticsTabs, RetentionGrid, share } from '@/components/analytics'
import { count } from '@/components/bits'
import { LEVEL_COLORS, PALETTE } from '@/components/charts'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { getRetention } from '@/fns'
import { ClientOnly } from '@tanstack/react-router'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'

type Search = { project?: string }

export const Route = createFileRoute('/analytics/retention')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const data = await getRetention({ data: { slug: deps.project } })
    if (!data) throw notFound()
    return data
  },
  head: () => ({ meta: [{ title: 'Retention · Analytics · crashyard' }] }),
  component: Retention,
})

const config = {
  without: { label: 'No error in their first week', color: PALETTE[0] },
  with: { label: 'Hit an error in their first week', color: LEVEL_COLORS.fatal },
} satisfies ChartConfig

function Retention() {
  const { project: p, retention } = Route.useLoaderData()
  const { project } = Route.useSearch()
  const d = retention && retention.users > 0 ? retention : null
  // Week 4 for each, or the furthest both reached
  const at = d
    ? Math.min(
        4,
        d.withError.findLastIndex((v, i) => v !== null && d.withoutError[i] !== null),
      )
    : -1
  return (
    <Shell crumbs={p ? [<Link to="/analytics/retention">Analytics</Link>, p.name] : ['Analytics']}>
      <PageHeader title="Retention">{p?.name}</PageHeader>
      <AnalyticsTabs at="/analytics/retention" project={project} />
      {!d ? (
        <Empty icon={IconRepeat} title="No returning users to show yet">
          Retention fills in once actions name their user. Set the user in the SDK with <code>Sentry.setUser</code>.
        </Empty>
      ) : (
        <>
          <section className="mb-6 grid gap-3 rounded-xl border p-3 pb-1 sm:p-4 sm:pb-1">
            <div>
              <h2 className="text-sm font-medium">Do errors drive people away?</h2>
              <p className="text-sm text-muted-foreground">
                {count(d.erredUsers)} of {count(d.users)} new users hit an error in their first week.
                {at > 0 && d.withError[at] !== null && d.withoutError[at] !== null && (
                  <>
                    {' '}
                    In week {at}, {share(d.withError[at]!)} of them came back, against {share(d.withoutError[at]!)} of
                    everyone else.
                  </>
                )}
              </p>
            </div>
            <ClientOnly fallback={<Skeleton className="h-44 w-full md:h-56" />}>
              <ChartContainer config={config} className="aspect-auto h-44 w-full md:h-56">
                <LineChart
                  data={d.withError.map((v, k) => ({
                    week: k,
                    with: v === null ? null : Math.round(v * 100),
                    without: d.withoutError[k] === null ? null : Math.round(d.withoutError[k]! * 100),
                  }))}
                  margin={{ left: 0, right: 8, top: 8 }}
                >
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="week" tickLine={false} axisLine={false} tickFormatter={(k) => `Week ${k}`} />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={40}
                    tickFormatter={(v) => `${v}%`}
                    domain={[0, 100]}
                  />
                  <ChartTooltip
                    content={<ChartTooltipContent labelFormatter={(_, p) => `Week ${p[0]?.payload.week}`} />}
                  />
                  <Line dataKey="without" stroke="var(--color-without)" strokeWidth={2} dot={false} connectNulls />
                  <Line dataKey="with" stroke="var(--color-with)" strokeWidth={2} dot={false} connectNulls />
                </LineChart>
              </ChartContainer>
            </ClientOnly>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 pb-2 text-xs text-muted-foreground">
              {Object.entries(config).map(([key, c]) => (
                <li key={key} className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-sm" style={{ background: c.color }} />
                  {c.label}
                </li>
              ))}
            </ul>
          </section>
          <h2 className="mb-1 text-sm font-medium">Weekly cohorts</h2>
          <p className="mb-2 text-sm text-muted-foreground">
            New users by the week of their first action, and the share who came back each week after.
          </p>
          <RetentionGrid cohorts={d.cohorts} />
        </>
      )}
    </Shell>
  )
}
