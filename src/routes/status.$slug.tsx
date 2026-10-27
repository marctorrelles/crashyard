import { createFileRoute, notFound } from '@tanstack/react-router'
import { percent } from '@/components/bits'
import { Logo } from '@/components/shell'
import { Time } from '@/components/time'
import { getStatusPage } from '@/fns'
import { cn } from '@/lib/utils'

// A project's public status page: open signed out (src/server.ts), its data read in the server render only
export const Route = createFileRoute('/status/$slug')({
  loader: async ({ params }) => {
    const page = await getStatusPage({ data: { slug: params.slug } })
    if (!page) throw notFound()
    return page
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: `${loaderData?.name ?? 'Status'} status` },
      // Fresh without a script: the page loads again each minute
      { httpEquiv: 'refresh', content: '60' },
    ],
  }),
  component: StatusPage,
})

type Page = Awaited<ReturnType<typeof getStatusPage>> & {}

const STATES = {
  ok: { label: 'Up', dot: 'bg-emerald-500' },
  failing: { label: 'Down', dot: 'bg-red-500' },
  pending: { label: 'Waiting for its first check', dot: 'bg-muted-foreground/40' },
  paused: { label: 'Paused', dot: 'bg-muted-foreground/40' },
} as const

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`
/** How long an incident lasted, in words */
const lasted = (ms: number) =>
  ms < 3_600_000
    ? plural(Math.max(1, Math.round(ms / 60_000)), 'minute')
    : ms < 86_400_000
      ? plural(Math.round(ms / 3_600_000), 'hour')
      : plural(Math.round(ms / 86_400_000), 'day')

const utcDay = (at: number) =>
  new Date(at).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' })

function Summary({ checks }: { checks: Page['checks'] }) {
  const down = checks.filter((c) => c.status === 'failing')
  const [text, tone] = down.length
    ? [
        down.length === 1 ? `${down[0].name} is down` : `${down.length} services are down`,
        'border-red-500/40 bg-red-500/10',
      ]
    : checks.some((c) => c.status === 'ok')
      ? ['Everything is up', 'border-emerald-500/40 bg-emerald-500/10']
      : ['Nothing checked yet', 'bg-card']
  return <p className={cn('rounded-xl border px-4 py-3 font-medium', tone)}>{text}</p>
}

function Days({ days }: { days: Page['checks'][number]['days'] }) {
  return (
    <div className="flex h-8 items-stretch gap-px sm:gap-0.5" role="img" aria-label="Uptime per day, the last 30 days">
      {days.map((d) => (
        <span
          key={d.at}
          title={`${utcDay(d.at)} · ${d.up === null ? 'No checks' : `${percent(d.up)} up`}`}
          className={cn(
            'flex-1 rounded-sm',
            d.up === null ? 'bg-border' : d.up === 1 ? 'bg-emerald-500' : d.up >= 0.99 ? 'bg-amber-500' : 'bg-red-500',
          )}
        />
      ))}
    </div>
  )
}

function StatusPage() {
  const page = Route.useLoaderData()
  return (
    <main className="min-h-dvh bg-muted/40 px-4 py-10">
      <div className="mx-auto grid max-w-2xl gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">{page.name} status</h1>
        <Summary checks={page.checks} />
        <section className="grid gap-px overflow-hidden rounded-xl border bg-border" aria-label="Services">
          {page.checks.map((c) => (
            <div key={c.name} className="grid gap-3 bg-card p-4">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span className={cn('size-2 rounded-full', STATES[c.status].dot)} />
                  {STATES[c.status].label}
                </span>
              </div>
              <Days days={c.days} />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>30 days ago</span>
                {c.uptime !== null && <span className="tabular-nums">{percent(c.uptime)} up</span>}
                <span>Today</span>
              </div>
            </div>
          ))}
        </section>
        <section className="grid gap-3">
          <h2 className="font-semibold">Incidents in the last 30 days</h2>
          {page.incidents.length ? (
            <ul className="grid gap-px overflow-hidden rounded-xl border bg-border">
              {page.incidents.map((i) => (
                <li key={`${i.check}-${i.opened}`} className="grid gap-0.5 bg-card px-4 py-3">
                  <span className="font-medium">{i.closed ? `${i.check} was down` : `${i.check} is down`}</span>
                  <span className="text-sm text-muted-foreground">
                    {i.closed ? (
                      <>
                        <Time at={i.opened} /> · for {lasted(i.closed - i.opened)}
                      </>
                    ) : (
                      <>
                        Since <Time at={i.opened} />
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">None. Every check passed.</p>
          )}
        </section>
        <footer className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>
            Updated <Time at={page.now} style="time" />
          </span>
          <span className="flex items-center gap-1.5">
            <Logo className="size-3.5 fill-current" />
            Checked by crashyard
          </span>
        </footer>
      </div>
    </main>
  )
}
