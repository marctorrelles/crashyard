import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router'
import { count, Level } from '@/components/bits'
import { BarList, TimeChart } from '@/components/charts'
import { Period } from '@/components/performance'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getAction } from '@/fns'
import { IconRoute } from '@tabler/icons-react'

type Search = { project: string; name: string; days?: number; by?: string }

export const Route = createFileRoute('/analytics/action')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: typeof s.project === 'string' ? s.project : '',
    name: typeof s.name === 'string' ? s.name : '',
    days: [1, 30].includes(Number(s.days)) ? Number(s.days) : undefined,
    by: typeof s.by === 'string' && s.by ? s.by : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    if (!deps.project || !deps.name) throw notFound()
    const data = await getAction({ data: { slug: deps.project, name: deps.name, days: deps.days ?? 7, by: deps.by } })
    if (!data) throw notFound()
    return data
  },
  head: ({ match }) => ({ meta: [{ title: `${match.search.name} · Analytics · crashyard` }] }),
  component: Action,
})

function Action() {
  const d = Route.useLoaderData()
  const { name, days } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
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
          <Period
            days={days ?? 7}
            onChange={(v) => void navigate({ search: (s) => ({ ...s, days: v === 7 ? undefined : v }) })}
          />
        }
      >
        {d.project.name} · {count(d.total)} times
      </PageHeader>
      <div className="mb-5 rounded-xl border p-3 pb-1">
        <TimeChart
          x={d.steps}
          series={[
            { key: 'count', label: 'Count', values: d.counts, kind: 'bar', color: 'var(--chart-1)' },
            { key: 'users', label: 'Users', values: d.users, kind: 'line', color: 'var(--chart-3)' },
          ]}
          stacked={false}
          legend
          className="h-36 md:h-48"
        />
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <section className="min-w-0 rounded-xl border p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">By property</h2>
            {d.keys.length > 0 && (
              <Select
                value={d.by}
                onValueChange={(v) => void navigate({ search: (s) => ({ ...s, by: v }), replace: true })}
              >
                <SelectTrigger size="sm" className="w-40" aria-label="Property">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {d.keys.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {d.values.length ? (
            <BarList items={d.values} total={d.total} />
          ) : (
            <p className="text-sm text-muted-foreground">This action has no properties.</p>
          )}
        </section>
        <section className="min-w-0 rounded-xl border p-3">
          <h2 className="mb-2 text-sm font-medium">By release</h2>
          <BarList items={d.releases.map((r) => ({ value: r.value || '(none)', count: r.count }))} total={d.total} />
        </section>
      </div>
      <section className="mt-5">
        <h2 className="mb-1 text-sm font-medium">Issues in the same trace</h2>
        <p className="mb-2 text-sm text-muted-foreground">
          Errors your app sent while someone was doing this, linked by their trace.
        </p>
        {d.issues.length ? (
          <ul className="divide-y rounded-xl border text-sm">
            {d.issues.map((i) => (
              <li key={i.id} className="flex items-center gap-2 px-4 py-2.5">
                <Level level={i.level} />
                <Link
                  to="/issues/$issueId"
                  params={{ issueId: String(i.id) }}
                  className="min-w-0 flex-1 truncate font-medium hover:underline"
                >
                  {i.title}
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {count(i.traces)} {i.traces === 1 ? 'time' : 'times'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon={IconRoute} title="No errors alongside it" compact>
            Nothing went wrong in the traces of this action. Long may it last.
          </Empty>
        )}
      </section>
    </Shell>
  )
}
