import { ClientOnly, createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router'
import { IconRepeat } from '@tabler/icons-react'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import {
  ActionSelect,
  AnalyticsTabs,
  FilterBar,
  type FilterSearch,
  readFilter,
  RetentionGrid,
  share,
  toFilter,
  openAnalyticsProject,
} from '@/components/analytics'
import { count } from '@/components/bits'
import { LEVEL_COLORS, PALETTE } from '@/components/charts'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import { getRetention } from '@/fns'

type Search = FilterSearch & { project?: string; start?: string; back?: string }

export const Route = createFileRoute('/analytics/retention')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
    start: typeof s.start === 'string' && s.start ? s.start : undefined,
    back: typeof s.back === 'string' && s.back ? s.back : undefined,
    ...readFilter(s),
  }),
  beforeLoad: ({ search }) => openAnalyticsProject('/analytics/retention', search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const data = await getRetention({
      data: { slug: deps.project, start: deps.start, back: deps.back, filter: toFilter(deps) },
    })
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
  const { project: p, names, options, retention } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
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
      <AnalyticsTabs at="/analytics/retention" search={search} />
      <FilterBar
        options={options}
        search={search}
        onChange={(f) => void navigate({ search: (s) => ({ ...s, ...f }) })}
      />
      {names.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Users who did</span>
          <ActionSelect
            names={names}
            value={search.start}
            any="any action"
            label="Starting action"
            className="w-48"
            onChange={(start) => void navigate({ search: (s) => ({ ...s, start }) })}
          />
          <span className="text-muted-foreground">and came back to do</span>
          <ActionSelect
            names={names}
            value={search.back}
            any="any action"
            label="Returning action"
            className="w-48"
            onChange={(back) => void navigate({ search: (s) => ({ ...s, back }) })}
          />
        </div>
      )}
      {!d ? (
        <Empty icon={IconRepeat} title="No new users in the last 8 weeks">
          Retention follows users from their first action. It fills in as new users come, as long as actions name their
          user with <code>Sentry.setUser</code>.
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
            New users by the week of their first action, and the share who came back each week after. Weeks run back
            from today. In the first 8 weeks of keeping actions, everyone counts as new.
          </p>
          <RetentionGrid cohorts={d.cohorts} />
        </>
      )}
    </Shell>
  )
}
