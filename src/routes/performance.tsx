import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router'
import { count } from '@/components/bits'
import { ms, Period } from '@/components/performance'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { getPerformance } from '@/fns'
import { cn } from '@/lib/utils'

type Search = { project?: string; days?: number }

export const Route = createFileRoute('/performance')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
    days: [1, 30].includes(Number(s.days)) ? Number(s.days) : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const data = await getPerformance({ data: { slug: deps.project, days: deps.days ?? 7 } })
    if (!data) throw notFound()
    return data
  },
  head: () => ({ meta: [{ title: 'Performance · crashyard' }] }),
  component: Performance,
})

function Performance() {
  const sections = Route.useLoaderData()
  const { project, days } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const shown = sections.filter((d) => d.transactions.length > 0)
  return (
    <Shell>
      <PageHeader
        title="Performance"
        actions={
          <Period
            days={days ?? 7}
            onChange={(v) => void navigate({ search: (s) => ({ ...s, days: v === 7 ? undefined : v }) })}
          />
        }
      >
        {project && sections[0]?.project.name}
      </PageHeader>
      {shown.length === 0 && (
        <Empty title="No transactions yet">
          Set the SDK&apos;s <code>tracesSampleRate</code> (0.1 is plenty) and each sampled screen load, request or job
          shows up here by name, slowest first.
        </Empty>
      )}
      <div className="grid gap-8">
        {shown.map((d) => (
          <section key={d.project.id}>
            {!project && <h2 className="mb-2 text-sm font-medium text-muted-foreground">{d.project.name}</h2>}
            {d.latest && d.previous && (
              <p className="mb-3 text-sm text-muted-foreground">
                Change: p95 in <span className="font-mono">{d.latest}</span> against{' '}
                <span className="font-mono">{d.previous}</span>
              </p>
            )}
            <Transactions slug={d.project.slug} transactions={d.transactions} days={days} />
          </section>
        ))}
      </div>
    </Shell>
  )
}

function Transactions({
  slug,
  transactions,
  days,
}: {
  slug: string
  transactions: NonNullable<Awaited<ReturnType<typeof getPerformance>>>[number]['transactions']
  days?: number
}) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="px-4 py-2 text-left font-medium">Transaction</th>
            <th className="px-3 py-2 text-right font-medium">Count</th>
            <th className="px-3 py-2 text-right font-medium max-sm:hidden">Errors</th>
            <th className="px-3 py-2 text-right font-medium max-sm:hidden">p50</th>
            <th className="px-3 py-2 text-right font-medium">p95</th>
            <th className="px-3 py-2 text-right font-medium max-sm:hidden">p99</th>
            <th className="px-4 py-2 text-right font-medium">Change</th>
          </tr>
        </thead>
        <tbody className="divide-y tabular-nums">
          {transactions.map((t) => (
            <tr key={t.name} className="hover:bg-muted/40">
              <td className="max-w-0 px-4 py-2.5">
                <Link
                  to="/projects/$slug/performance/transaction"
                  params={{ slug }}
                  search={{ name: t.name, days }}
                  className="block truncate font-mono text-xs font-medium hover:underline"
                >
                  {t.name}
                </Link>
              </td>
              <td className="px-3 py-2.5 text-right">{count(t.count)}</td>
              <td className="px-3 py-2.5 text-right max-sm:hidden">
                {t.errors ? `${((t.errors / t.count) * 100).toFixed(1)}%` : '–'}
              </td>
              <td className="px-3 py-2.5 text-right max-sm:hidden">{ms(t.p50)}</td>
              <td className="px-3 py-2.5 text-right font-medium">{ms(t.p95)}</td>
              <td className="px-3 py-2.5 text-right max-sm:hidden">{ms(t.p99)}</td>
              <td className="px-4 py-2.5 text-right">
                <Change value={t.change} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Change({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">–</span>
  const pct = Math.round(value * 100)
  return (
    <span
      className={cn(
        pct >= 20 && 'text-red-600 dark:text-red-400',
        pct <= -20 && 'text-emerald-600 dark:text-emerald-400',
        Math.abs(pct) < 20 && 'text-muted-foreground',
      )}
    >
      {pct > 0 ? '+' : ''}
      {pct}%
    </span>
  )
}
