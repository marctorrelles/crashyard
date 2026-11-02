import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router'
import { IconBell, IconChartLine, IconRoute } from '@tabler/icons-react'
import {
  Breakdown,
  FilterBar,
  type FilterSearch,
  IssueRows,
  PeriodSelect,
  readDays,
  readFilter,
  toFilter,
} from '@/components/analytics'
import { count } from '@/components/bits'
import { BarList, PALETTE, TimeChart } from '@/components/charts'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getAction } from '@/fns'

type Search = FilterSearch & { project: string; name: string; days?: number; by?: string }

export const Route = createFileRoute('/analytics/action')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: typeof s.project === 'string' ? s.project : '',
    name: typeof s.name === 'string' ? s.name : '',
    days: readDays(s.days),
    by: typeof s.by === 'string' && s.by ? s.by : undefined,
    ...readFilter(s),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    if (!deps.project || !deps.name) throw notFound()
    const data = await getAction({
      data: { slug: deps.project, name: deps.name, days: deps.days ?? 30, by: deps.by, filter: toFilter(deps) },
    })
    if (!data) throw notFound()
    return data
  },
  head: ({ match }) => ({ meta: [{ title: `${match.search.name} · Analytics · crashyard` }] }),
  component: Action,
})

function Action() {
  const d = Route.useLoaderData()
  const search = Route.useSearch()
  const { name, days } = search
  const navigate = useNavigate({ from: Route.fullPath })
  const quoted = `action:"${name.replaceAll('"', '')}"`
  return (
    <Shell
      crumbs={[
        <Link to="/analytics">Analytics</Link>,
        <Link to="/analytics" search={{ project: d.project.slug }}>
          {d.project.name}
        </Link>,
        name,
      ]}
    >
      <PageHeader
        title={<span className="font-mono">{name}</span>}
        actions={
          <>
            <Button variant="outline" className="h-10" asChild>
              <Link to="/analytics/insights" search={{ project: d.project.slug, names: [name] }}>
                <IconChartLine />
                Open in Insights
              </Link>
            </Button>
            <Button variant="outline" className="h-10" asChild>
              <Link to="/settings/notifications" search={{ metric: 'actions', query: quoted, project: d.project.slug }}>
                <IconBell />
                Create alert
              </Link>
            </Button>
            <PeriodSelect
              days={days ?? 30}
              onChange={(v) => void navigate({ search: (s) => ({ ...s, days: v === 30 ? undefined : v }) })}
            />
          </>
        }
      >
        {d.project.name} · {count(d.total)} times by {count(d.totalUsers)} users
      </PageHeader>
      <FilterBar
        options={d.options}
        search={search}
        onChange={(f) => void navigate({ search: (s) => ({ ...s, ...f }) })}
      />
      <div className="mb-5 rounded-xl border p-3 pb-1">
        <TimeChart
          x={d.steps}
          series={[
            { key: 'count', label: 'Count', values: d.counts, kind: 'bar', color: 'var(--chart-1)' },
            { key: 'users', label: 'Users', values: d.users, kind: 'line', color: PALETTE[0] },
          ]}
          stacked={false}
          legend
          className="h-36 md:h-48"
        />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <section className="min-w-0 rounded-xl border p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">By property</h2>
            {d.keys.length > 0 && (
              <Select
                value={d.by}
                onValueChange={(v) => void navigate({ search: (s) => ({ ...s, by: v }), replace: true })}
              >
                <SelectTrigger size="sm" className="w-36" aria-label="Property">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {d.keys.map((k) => (
                    <SelectItem key={k} value={k} className="font-mono text-xs">
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {d.values.length ? (
            <BarList
              items={d.values}
              total={d.total}
              onInclude={d.by ? (v) => void navigate({ search: (s) => ({ ...s, prop: `${d.by}:${v}` }) }) : undefined}
            />
          ) : (
            <p className="text-sm text-muted-foreground">This action has no properties.</p>
          )}
        </section>
        {(
          [
            ['release', 'By release', d.releases],
            ['platform', 'By platform', d.platforms],
            ['country', 'By country', d.countries],
          ] as const
        ).map(([field, title, items]) => (
          <Breakdown
            key={field}
            title={title}
            field={field}
            items={items}
            total={d.total}
            unit="times"
            onPick={(v) => void navigate({ search: (s) => ({ ...s, [field]: v }) })}
          />
        ))}
      </div>
      <section className="mt-6">
        <h2 className="mb-1 text-sm font-medium">Issues in the same trace</h2>
        <p className="mb-2 text-sm text-muted-foreground">
          Errors your app sent in the same trace as this action. Without tracing, a trace can span a whole page load or
          app session, so read these as nearby rather than caused by it.
        </p>
        {d.issues.length ? (
          <IssueRows issues={d.issues.map((i) => ({ ...i, count: i.traces, unit: 'time' }))} />
        ) : (
          <Empty icon={IconRoute} title="No errors alongside it" compact>
            Nothing went wrong in the traces of this action.
          </Empty>
        )}
      </section>
    </Shell>
  )
}
