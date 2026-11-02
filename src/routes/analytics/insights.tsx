import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router'
import { IconChartLine, IconLayoutDashboard, IconPlus, IconX } from '@tabler/icons-react'
import { useState } from 'react'
import { AddToDashboard } from '@/components/add-to-dashboard'
import {
  ActionSelect,
  AnalyticsTabs,
  BreakdownSelect,
  Change,
  FilterBar,
  type FilterSearch,
  PeriodSelect,
  readDays,
  readFilter,
  toFilter,
  valueLabel,
  openAnalyticsProject,
} from '@/components/analytics'
import { count } from '@/components/bits'
import { PALETTE, TimeChart } from '@/components/charts'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Widget } from '@/data/widgets'
import { getInsights } from '@/fns'

const MEASURES = { users: 'Unique users', total: 'Total', per_user: 'Per user' } as const
type Measure = keyof typeof MEASURES
type Search = FilterSearch & { project?: string; names?: string[]; measure?: Measure; by?: string; days?: number }

export const Route = createFileRoute('/analytics/insights')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
    names: Array.isArray(s.names) ? s.names.filter((v): v is string => typeof v === 'string').slice(0, 3) : undefined,
    measure: typeof s.measure === 'string' && s.measure in MEASURES ? (s.measure as Measure) : undefined,
    by: typeof s.by === 'string' && s.by ? s.by : undefined,
    days: readDays(s.days),
    ...readFilter(s),
  }),
  beforeLoad: ({ search }) => openAnalyticsProject('/analytics/insights', search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const data = await getInsights({
      data: {
        slug: deps.project,
        names: deps.names ?? [],
        measure: deps.measure ?? 'users',
        by: deps.by,
        days: deps.days ?? 30,
        filter: toFilter(deps),
      },
    })
    if (!data) throw notFound()
    return data
  },
  head: () => ({ meta: [{ title: 'Insights · Analytics · crashyard' }] }),
  component: Insights,
})

// Widgets group by these columns; a property breakdown stays on this page
const WIDGET_GROUPS = ['platform', 'os', 'country', 'release', 'device']

function Insights() {
  const { project: p, names, options, chosen, insights } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [adding, setAdding] = useState<Widget | null>(null)
  const measure = search.measure ?? 'users'
  const setNames = (next: string[]) => void navigate({ search: (s) => ({ ...s, names: next }) })
  const series = insights?.series ?? []
  const format = (v: number) => (measure === 'per_user' ? v.toFixed(1) : count(Math.round(v)))
  const label = (s: (typeof series)[number]) =>
    s.group === null
      ? s.name
      : `${chosen.length > 1 ? `${s.name} · ` : ''}${valueLabel(search.by?.replace(/^prop:/, '') ?? '', s.group)}`
  // As a dashboard widget: each action a query with the filter's columns, unique users or a count, grouped by a column
  const quote = (v: string) => `"${v.replaceAll('"', '')}"`
  const filter = (['release', 'platform', 'os', 'country'] as const)
    .flatMap((k) => (search[k] ? [`${k}:${quote(search[k])}`] : []))
    .join(' ')
  const widget: Widget | null =
    measure !== 'per_user' && !search.prop && (!search.by || WIDGET_GROUPS.includes(search.by))
      ? {
          id: '',
          title: chosen.length === 1 ? chosen[0] : 'Actions',
          dataset: 'actions',
          display: 'line',
          queries: chosen.map((n) => ({
            query: `action:${quote(n)}${filter ? ` ${filter}` : ''}`,
            aggregate: measure === 'users' ? 'count_unique(user)' : 'count',
            label: n.slice(0, 40),
          })),
          ...(search.by ? { groupBy: [search.by] } : {}),
          width: 2,
        }
      : null
  return (
    <Shell crumbs={p ? [<Link to="/analytics/insights">Analytics</Link>, p.name] : ['Analytics']}>
      <PageHeader
        title="Insights"
        actions={
          <PeriodSelect
            days={search.days ?? 30}
            onChange={(v) => void navigate({ search: (s) => ({ ...s, days: v === 30 ? undefined : v }) })}
          />
        }
      >
        {p?.name}
      </PageHeader>
      <AnalyticsTabs at="/analytics/insights" search={search} />
      <FilterBar
        options={options}
        search={search}
        onChange={(f) => void navigate({ search: (s) => ({ ...s, ...f }) })}
      />
      {names.length === 0 ? (
        <Empty icon={IconChartLine} title="No actions to chart yet">
          Insights charts the actions your app sends. Once it sends some, pick one or more here.
        </Empty>
      ) : (
        <>
          <section aria-label="Chart" className="mb-4 grid gap-3 rounded-xl border p-3">
            <div className="flex flex-wrap items-center gap-2">
              {chosen.map((n, i) => (
                <div key={i} className="flex min-w-0 items-center gap-1 max-sm:w-full">
                  <span className="size-2.5 shrink-0 rounded-sm" style={{ background: PALETTE[i] }} aria-hidden />
                  <ActionSelect
                    names={names}
                    value={n}
                    label={`Action ${i + 1}`}
                    className="w-52 max-sm:flex-1"
                    onChange={(v) => v && setNames(chosen.map((x, j) => (j === i ? v : x)))}
                  />
                  {chosen.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-10"
                      aria-label={`Remove ${n}`}
                      onClick={() => setNames(chosen.filter((_, j) => j !== i))}
                    >
                      <IconX />
                    </Button>
                  )}
                </div>
              ))}
              {chosen.length < 3 && (
                <Button
                  variant="outline"
                  className="h-10"
                  onClick={() => setNames([...chosen, names.find((n) => !chosen.includes(n)) ?? names[0]])}
                >
                  <IconPlus />
                  Compare with
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={measure}
                onValueChange={(v) =>
                  void navigate({ search: (s) => ({ ...s, measure: v === 'users' ? undefined : (v as Measure) }) })
                }
              >
                <SelectTrigger className="h-10 w-40" aria-label="Measure">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(MEASURES).map(([v, l]) => (
                    <SelectItem key={v} value={v}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <BreakdownSelect
                value={search.by}
                onChange={(by) => void navigate({ search: (s) => ({ ...s, by }) })}
                properties={options.properties}
                label="Breakdown"
              />
              <Button
                variant="outline"
                className="ml-auto h-10 max-sm:ml-0"
                disabled={!widget}
                title={
                  widget
                    ? undefined
                    : 'A dashboard shows unique users or a total, by a column, without a property filter.'
                }
                onClick={() =>
                  widget && setAdding({ ...widget, id: Math.random().toString(16).slice(2, 10).padEnd(8, '0') })
                }
              >
                <IconLayoutDashboard />
                Add to dashboard
              </Button>
            </div>
          </section>
          <div className="mb-4 rounded-xl border p-3 pb-1">
            {series.length ? (
              <TimeChart
                x={insights!.steps}
                series={series.map((s, i) => ({
                  key: `s${i}`,
                  label: label(s),
                  values: s.values,
                  kind: 'line',
                  color: PALETTE[i % PALETTE.length],
                }))}
                stacked={false}
                legend
                format={format}
                className="h-56 md:h-72"
              />
            ) : (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Nothing matches this period and these filters.
              </p>
            )}
          </div>
          {series.length > 0 && (
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-sm tabular-nums">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="w-1/2 px-4 py-2 text-left font-medium">Line</th>
                    <th className="px-3 py-2 text-right font-medium">{MEASURES[measure]}</th>
                    <th className="px-3 py-2 text-right font-medium max-sm:hidden">The period before</th>
                    <th className="px-4 py-2 text-right font-medium">Change</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {series.map((s, i) => (
                    <tr key={s.key}>
                      <td className="max-w-0 px-4 py-2.5">
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className="size-2.5 shrink-0 rounded-sm"
                            style={{ background: PALETTE[i % PALETTE.length] }}
                            aria-hidden
                          />
                          <span className="truncate font-mono text-xs">{label(s)}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-medium">{format(s.total)}</td>
                      <td className="px-3 py-2.5 text-right text-muted-foreground max-sm:hidden">
                        {format(s.previous)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Change value={s.change} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {adding && (
        <AddToDashboard
          widget={adding}
          onClose={() => setAdding(null)}
          description="The chart joins the end of the dashboard, with these actions."
        />
      )}
    </Shell>
  )
}
