import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { Ago, count } from '@/components/bits'
import { ms, P95Chart, Period, Waterfall } from '@/components/performance'
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
    <Shell>
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
      <Link
        to="/projects/$slug/performance"
        params={{ slug: d.project.slug }}
        search={{ days: search.days }}
        className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeftIcon className="size-4" />
        Transactions
      </Link>
      <h2 className="mb-1 font-mono text-base font-semibold break-all">{search.name}</h2>
      <p className="mb-5 text-sm text-muted-foreground">
        {count(total)} in this period{errors > 0 && <> · {count(errors)} failed</>}
      </p>
      <section className="mb-6 rounded-xl border p-4">
        <P95Chart series={d.series} />
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
          <p className="text-sm text-muted-foreground">None kept in this period: examples are kept 30 days.</p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {d.examples.map((e) => (
              <li key={e.id}>
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-2.5 hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
                    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
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
                          Logs of this trace
                        </Link>
                        <Link
                          to="/issues"
                          search={{ query: `trace:${e.trace_id}` }}
                          className="underline-offset-2 hover:underline"
                        >
                          Issues of this trace
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
