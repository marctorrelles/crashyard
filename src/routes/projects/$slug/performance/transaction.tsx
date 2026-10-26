import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router'
import { IconChevronRight } from '@tabler/icons-react'
import { Ago, count } from '@/components/bits'
import { TimeChart } from '@/components/charts'
import { ms, Period, Waterfall } from '@/components/performance'
import { PageHeader, Shell } from '@/components/shell'
import { Badge } from '@/components/ui/badge'
import { getTransaction } from '@/fns'

type Search = { name: string; days?: number }

export const Route = createFileRoute('/projects/$slug/performance/transaction')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    name: typeof s.name === 'string' ? s.name : '',
    days: [1, 30].includes(Number(s.days)) ? Number(s.days) : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps }) => {
    const data = await getTransaction({ data: { slug: params.slug, name: deps.name, days: deps.days ?? 7 } })
    if (!data) throw notFound()
    return data
  },
  head: ({ match }) => ({ meta: [{ title: `${match.search.name} · crashyard` }] }),
  component: Transaction,
})

function Transaction() {
  const d = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const total = d.series.reduce((a, s) => a + s.count, 0)
  const errors = d.series.reduce((a, s) => a + s.errors, 0)
  return (
    <Shell
      crumbs={[
        <Link to="/performance">Performance</Link>,
        <Link to="/performance" search={{ project: d.project.slug, days: search.days }}>
          {d.project.name}
        </Link>,
        search.name,
      ]}
    >
      <PageHeader
        title="Performance"
        actions={
          <Period
            days={search.days ?? 7}
            onChange={(v) => void navigate({ search: (s) => ({ ...s, days: v === 7 ? undefined : v }) })}
          />
        }
      >
        {d.project.name}
      </PageHeader>
      <h2 className="mb-1 font-mono text-base font-semibold break-all">{search.name}</h2>
      <p className="mb-5 text-sm text-muted-foreground">
        {count(total)} transactions in this period{errors > 0 && <> · {count(errors)} failed</>}
      </p>
      <section className="mb-6 rounded-xl border p-3 pb-1" aria-label="p95 and count per hour">
        <p className="mb-2 text-sm text-muted-foreground">
          The line is the p95 duration per hour, on the left axis. The bars are the number of transactions, on the
          right.
        </p>
        <TimeChart
          x={d.series.map((s) => s.hour)}
          series={[
            {
              key: 'count',
              label: 'Count',
              values: d.series.map((s) => s.count),
              kind: 'bar',
              axis: 'right',
              color: 'color-mix(in oklab, var(--muted-foreground) 35%, transparent)',
            },
            {
              key: 'p95',
              label: 'p95 in ms',
              values: d.series.map((s) => s.p95),
              kind: 'line',
              color: 'var(--foreground)',
            },
          ]}
          format={(v) => ms(v)}
          className="h-40 md:h-52"
        />
      </section>
      {d.releases.length > 0 && (
        <section className="mb-6">
          <h3 className="mb-2 text-sm font-medium">By release</h3>
          <ul className="divide-y rounded-xl border text-sm tabular-nums">
            {d.releases.map((r) => (
              <li key={r.release} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.release || 'no release'}</span>
                <span className="text-muted-foreground">{count(r.count)}</span>
                <span className="w-20 text-right text-muted-foreground">p50 {ms(r.p50)}</span>
                <span className="w-20 text-right font-medium">p95 {ms(r.p95)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h3 className="mb-2 text-sm font-medium">Slowest</h3>
        {d.examples.length === 0 ? (
          <p className="text-sm text-muted-foreground">No examples in this period. Examples are kept for 30 days.</p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {d.examples.map((e) => (
              <li key={e.id}>
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-2.5 hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
                    <IconChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                    <span className="w-16 text-sm font-medium tabular-nums">{ms(e.duration)}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{e.release}</span>
                    {e.status && e.status !== 'ok' && <Badge variant="destructive">{e.status}</Badge>}
                    <Ago at={e.timestamp} now={d.now} className="text-xs text-muted-foreground" />
                  </summary>
                  <div className="border-t bg-muted/20">
                    <Waterfall spans={e.spans} duration={e.duration} />
                    {e.trace_id && (
                      <p className="flex flex-wrap gap-4 px-4 pb-3 text-xs">
                        <Link
                          to="/logs"
                          search={{ query: `trace:${e.trace_id}`, range: '30d' }}
                          className="underline-offset-2 hover:underline"
                        >
                          Logs in this trace
                        </Link>
                        <Link
                          to="/issues"
                          search={{ query: `trace:${e.trace_id}` }}
                          className="underline-offset-2 hover:underline"
                        >
                          Issues in this trace
                        </Link>
                      </p>
                    )}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  )
}
