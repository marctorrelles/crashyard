import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { IconRoute } from '@tabler/icons-react'
import { Level } from '@/components/bits'
import { ms, Waterfall } from '@/components/performance'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { Time } from '@/components/time'
import { Badge } from '@/components/ui/badge'
import { getTrace } from '@/fns'

export const Route = createFileRoute('/traces/$traceId')({
  loader: async ({ params }) => {
    if (!/^[0-9a-f]{32}$/i.test(params.traceId)) throw notFound()
    return getTrace({ data: { traceId: params.traceId } })
  },
  head: ({ params }) => ({ meta: [{ title: `Trace ${params.traceId.slice(0, 8)} · crashyard` }] }),
  component: Trace,
})

function Trace() {
  const d = Route.useLoaderData()
  const nothing = !d.events.length && !d.logs.length && !d.transactions.length
  return (
    <Shell crumbs={[`Trace ${d.traceId.slice(0, 8)}`]}>
      <PageHeader title="Trace">
        <span className="font-mono break-all">{d.traceId}</span>
      </PageHeader>
      <p className="mb-6 text-sm text-muted-foreground">
        Everything crashyard keeps for this trace: its events, its logs, and its transactions with their spans. Only the
        slowest transactions of each day keep their spans, so most traces show events and logs alone.
      </p>
      {nothing ? (
        <Empty icon={IconRoute} title="Nothing kept for this trace">
          Its events and logs may be past their retention, or it never reached crashyard.
        </Empty>
      ) : (
        <div className="grid gap-6 *:min-w-0">
          {d.transactions.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-medium">
                Transactions <span className="font-normal text-muted-foreground">{d.transactions.length}</span>
              </h2>
              <ul className="divide-y rounded-xl border">
                {d.transactions.map((t) => (
                  <li key={t.id}>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                      <Link
                        to="/projects/$slug/performance/transaction"
                        params={{ slug: t.project }}
                        search={{ name: t.name }}
                        className="min-w-0 flex-1 truncate font-mono text-xs font-medium hover:underline"
                      >
                        {t.name}
                      </Link>
                      <span className="text-sm font-medium tabular-nums">{ms(t.duration)}</span>
                      {t.status && t.status !== 'ok' && <Badge variant="destructive">{t.status}</Badge>}
                      <Time at={t.timestamp} className="text-xs text-muted-foreground" />
                    </div>
                    <div className="border-t bg-muted/20">
                      <Waterfall spans={t.spans} duration={t.duration} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h2 className="mb-2 text-sm font-medium">
              Events <span className="font-normal text-muted-foreground">{d.events.length || ''}</span>
            </h2>
            {d.events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No errors in this trace.</p>
            ) : (
              <ul className="divide-y rounded-xl border">
                {d.events.map((e) => (
                  <li key={e.id}>
                    <Link
                      to="/issues/$issueId"
                      params={{ issueId: String(e.issue_id) }}
                      search={{ event: e.id }}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40"
                    >
                      <Level level={e.level} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{e.title}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {[e.project, e.release, e.culprit].filter(Boolean).join(' · ')}
                        </p>
                      </div>
                      {e.status !== 'unresolved' && <Badge variant="outline">{e.status}</Badge>}
                      <Time at={e.received} className="shrink-0 text-xs text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h2 className="mb-2 text-sm font-medium">
              Logs <span className="font-normal text-muted-foreground">{d.logs.length || ''}</span>
            </h2>
            {d.logs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No logs in this trace.</p>
            ) : (
              <ul className="divide-y rounded-xl border font-mono text-xs">
                {d.logs.map((l) => (
                  <li key={l.id} className="flex items-baseline gap-3 px-4 py-1.5">
                    <Time at={l.timestamp} style="seconds" className="shrink-0 text-muted-foreground" />
                    <span className="w-10 shrink-0 uppercase">{l.level}</span>
                    <span className="min-w-0 flex-1 break-words">{l.body}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Shell>
  )
}
