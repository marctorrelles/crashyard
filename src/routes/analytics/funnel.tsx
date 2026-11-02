import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router'
import { IconChartFunnel, IconPlus, IconX } from '@tabler/icons-react'
import { AnalyticsTabs, FunnelSteps, share } from '@/components/analytics'
import { count } from '@/components/bits'
import { Period } from '@/components/performance'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getFunnel } from '@/fns'

type Search = { project?: string; steps?: string[]; days?: number }

export const Route = createFileRoute('/analytics/funnel')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
    steps: Array.isArray(s.steps) ? s.steps.filter((v): v is string => typeof v === 'string').slice(0, 8) : undefined,
    days: [1, 7].includes(Number(s.days)) ? Number(s.days) : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const data = await getFunnel({ data: { slug: deps.project, steps: deps.steps ?? [], days: deps.days ?? 30 } })
    if (!data) throw notFound()
    return data
  },
  head: () => ({ meta: [{ title: 'Funnel · Analytics · crashyard' }] }),
  component: Funnel,
})

function Funnel() {
  const { project: p, names, steps, funnel } = Route.useLoaderData()
  const { project, days } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const setSteps = (next: string[]) => void navigate({ search: (s) => ({ ...s, steps: next }) })
  const first = funnel[0]
  const last = funnel.at(-1)
  const dropped = funnel.reduce((n, s) => n + s.dropped, 0)
  const erred = funnel.reduce((n, s) => n + s.droppedWithError, 0)
  return (
    <Shell crumbs={p ? [<Link to="/analytics/funnel">Analytics</Link>, p.name] : ['Analytics']}>
      <PageHeader
        title="Funnel"
        actions={
          <Period
            days={days ?? 30}
            onChange={(v) => void navigate({ search: (s) => ({ ...s, days: v === 30 ? undefined : v }) })}
          />
        }
      >
        {p?.name}
      </PageHeader>
      <AnalyticsTabs at="/analytics/funnel" project={project} />
      {names.length < 2 ? (
        <Empty icon={IconChartFunnel} title="Not enough actions for a funnel">
          A funnel needs two actions or more. Once your app sends them, pick the steps people take in order here.
        </Empty>
      ) : (
        <>
          <section aria-label="Steps" className="mb-5 rounded-xl border p-3">
            <p className="mb-2 text-sm text-muted-foreground">
              Users who did each action in this order, each within a day of the one before.
            </p>
            <ol className="flex flex-wrap items-center gap-2">
              {steps.map((step, i) => (
                <li key={i} className="flex min-w-0 items-center gap-1 max-sm:w-full">
                  <span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                  <Select value={step} onValueChange={(v) => setSteps(steps.map((s, j) => (j === i ? v : s)))}>
                    <SelectTrigger className="w-52 font-mono text-xs max-sm:flex-1" aria-label={`Step ${i + 1}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {names.map((n) => (
                        <SelectItem key={n} value={n} className="font-mono text-xs">
                          {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {steps.length > 2 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove step ${i + 1}`}
                      onClick={() => setSteps(steps.filter((_, j) => j !== i))}
                    >
                      <IconX />
                    </Button>
                  )}
                </li>
              ))}
              {steps.length < 8 && (
                <li>
                  <Button
                    variant="outline"
                    onClick={() => setSteps([...steps, names.find((n) => !steps.includes(n)) ?? names[0]])}
                  >
                    <IconPlus />
                    Add step
                  </Button>
                </li>
              )}
            </ol>
          </section>
          {first && last && (
            <dl className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[
                ['Started', count(first.users)],
                ['Finished', count(last.users)],
                ['Conversion', share(last.ofFirst)],
                ['Stopped after an error', dropped ? share(erred / dropped) : '–'],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0 rounded-xl border p-3">
                  <dt className="truncate text-xs text-muted-foreground">{label}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          <FunnelSteps steps={funnel} />
        </>
      )}
    </Shell>
  )
}
