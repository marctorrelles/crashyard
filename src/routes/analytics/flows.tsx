import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router'
import { IconAlertTriangle, IconArrowRight, IconDoorExit, IconRoute } from '@tabler/icons-react'
import {
  ActionSelect,
  AnalyticsTabs,
  FilterBar,
  type FilterSearch,
  PeriodSelect,
  readDays,
  readFilter,
  share,
  toFilter,
  openAnalyticsProject,
} from '@/components/analytics'
import { count } from '@/components/bits'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { getFlows } from '@/fns'
import { cn } from '@/lib/utils'

type Search = FilterSearch & { project?: string; anchor?: string; direction?: 'before'; days?: number }

export const Route = createFileRoute('/analytics/flows')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
    anchor: typeof s.anchor === 'string' && s.anchor ? s.anchor : undefined,
    direction: s.direction === 'before' ? 'before' : undefined,
    days: readDays(s.days),
    ...readFilter(s),
  }),
  beforeLoad: ({ search }) => openAnalyticsProject('/analytics/flows', search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const data = await getFlows({
      data: {
        slug: deps.project,
        anchor: deps.anchor,
        direction: deps.direction ?? 'after',
        days: deps.days ?? 30,
        filter: toFilter(deps),
      },
    })
    if (!data) throw notFound()
    return data
  },
  head: () => ({ meta: [{ title: 'Flows · Analytics · crashyard' }] }),
  component: Flows,
})

type Data = NonNullable<Awaited<ReturnType<typeof getFlows>>>
type Issues = NonNullable<Data['flows']>['issues']

/** A step as it reads: an action, an error by its issue, or the end of the visit */
function Label({ label, issues }: { label: string; issues: Issues }) {
  if (label === 'end')
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <IconDoorExit className="size-4 shrink-0" />
        Left
      </span>
    )
  if (label.startsWith('error:')) {
    const issue = issues[Number(label.slice(6))]
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-amber-700 dark:text-amber-400">
        <IconAlertTriangle className="size-4 shrink-0" />
        {issue ? (
          <Link
            to="/issues/$issueId"
            params={{ issueId: String(issue.id) }}
            className="truncate hover:underline"
            title={issue.title}
          >
            {issue.title}
          </Link>
        ) : (
          'An error'
        )}
      </span>
    )
  }
  return <span className="truncate font-mono text-xs">{label}</span>
}

function Flows() {
  const { project: p, names, options, anchor, flows } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const after = search.direction !== 'before'
  return (
    <Shell crumbs={p ? [<Link to="/analytics/flows">Analytics</Link>, p.name] : ['Analytics']}>
      <PageHeader
        title="Flows"
        actions={
          <PeriodSelect
            days={search.days ?? 30}
            onChange={(v) => void navigate({ search: (s) => ({ ...s, days: v === 30 ? undefined : v }) })}
          />
        }
      >
        {p?.name}
      </PageHeader>
      <AnalyticsTabs at="/analytics/flows" search={search} />
      <FilterBar
        options={options}
        search={search}
        onChange={(f) => void navigate({ search: (s) => ({ ...s, ...f }) })}
      />
      {!anchor ? (
        <Empty icon={IconRoute} title="No actions to follow yet">
          Flows show what people do before and after an action, errors included. They fill in once your app sends
          actions.
        </Empty>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">What people did</span>
            <ToggleGroup
              type="single"
              variant="outline"
              value={after ? 'after' : 'before'}
              onValueChange={(v) =>
                v && void navigate({ search: (s) => ({ ...s, direction: v === 'before' ? 'before' : undefined }) })
              }
            >
              <ToggleGroupItem value="before" className="h-10 px-3">
                Before
              </ToggleGroupItem>
              <ToggleGroupItem value="after" className="h-10 px-3">
                After
              </ToggleGroupItem>
            </ToggleGroup>
            <ActionSelect
              names={names}
              value={anchor}
              label="Action"
              className="w-52"
              onChange={(v) => v && void navigate({ search: (s) => ({ ...s, anchor: v }) })}
            />
          </div>
          {!flows || flows.users === 0 ? (
            <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              No one with a user did this action in this period.
            </p>
          ) : (
            <>
              <p className="mb-3 text-sm text-muted-foreground">
                {count(flows.users)} users, from their first time in the period, within the same visit: steps under 30
                minutes apart.{flows.partial && ' Only the first 200,000 actions of the period are read.'}
              </p>
              <div className="mb-8 flex gap-3 overflow-x-auto pb-2 *:shrink-0 max-sm:flex-col">
                <div className={cn('flex shrink-0 flex-col justify-center', !after && 'order-last')}>
                  <div className="w-40 rounded-xl border-2 p-3 max-sm:w-full" style={{ borderColor: 'var(--chart-1)' }}>
                    <p className="text-xs text-muted-foreground">{after ? 'Starting at' : 'Ending at'}</p>
                    <p className="truncate font-mono text-xs font-medium" title={anchor}>
                      {anchor}
                    </p>
                    <p className="text-sm font-semibold tabular-nums">{count(flows.users)} users</p>
                  </div>
                </div>
                {(after ? flows.columns : [...flows.columns].reverse()).map((c, i) => {
                  const step = after ? i + 1 : flows.columns.length - i
                  return (
                    <section
                      key={step}
                      className="grow basis-52 rounded-xl border p-3 max-sm:basis-auto lg:min-w-44 lg:basis-0"
                      aria-label={`Step ${step}`}
                    >
                      <h3 className="mb-2 text-xs text-muted-foreground">
                        {after ? `Step ${step} after` : `Step ${step} before`}
                      </h3>
                      <ul className="grid grid-cols-1 gap-2">
                        {c.items.map((item) => (
                          <li key={item.label} className="grid grid-cols-1 gap-1 text-sm">
                            <div className="flex min-w-0 items-center justify-between gap-2">
                              <Label label={item.label} issues={flows.issues} />
                              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                {share(item.count / flows.users)}
                              </span>
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                              <div
                                className="h-full rounded-full"
                                style={{
                                  width: `${(item.count / flows.users) * 100}%`,
                                  background: item.label.startsWith('error:')
                                    ? 'var(--color-amber-500)'
                                    : item.label === 'end'
                                      ? 'var(--muted-foreground)'
                                      : 'var(--chart-1)',
                                }}
                              />
                            </div>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )
                })}
              </div>
              <h2 className="mb-2 text-sm font-medium">Most common paths</h2>
              <ol className="divide-y rounded-xl border">
                {flows.paths.map((path, i) => {
                  const steps = after ? [anchor, ...path.steps] : [...path.steps].reverse().concat(anchor)
                  return (
                    <li key={i} className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-4 py-2.5 text-sm">
                      {steps.map((s, k) => (
                        <span key={k} className="flex min-w-0 items-center gap-1.5">
                          {k > 0 && <IconArrowRight className="size-3.5 shrink-0 text-muted-foreground" />}
                          <span className={cn('min-w-0', s === anchor && 'font-semibold')}>
                            <Label label={s} issues={flows.issues} />
                          </span>
                        </span>
                      ))}
                      <span className="ml-auto pl-2 text-xs text-muted-foreground tabular-nums">
                        {count(path.count)} · {share(path.count / flows.users)}
                      </span>
                    </li>
                  )
                })}
              </ol>
            </>
          )}
        </>
      )}
    </Shell>
  )
}
