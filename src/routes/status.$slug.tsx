import { createFileRoute, notFound } from '@tanstack/react-router'
import { percent } from '@/components/bits'
import { Markdown } from '@/components/markdown'
import { Logo } from '@/components/shell'
import { Time } from '@/components/time'
import { stateLabel } from '@/data/status'
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
type Post = Page['posts'][number]

const RANK: Post['impact'][] = ['major', 'minor', 'maintenance', 'notice']

const STRIPES: Record<Post['impact'], string> = {
  major: 'border-l-red-500',
  minor: 'border-l-amber-500',
  maintenance: 'border-l-sky-500',
  notice: 'border-l-muted-foreground/40',
}

/** A post as the page shows it: its title, its window for maintenance, then its updates, newest first */
function PostCard({ post }: { post: Post }) {
  return (
    <article className={cn('grid gap-3 rounded-xl border border-l-4 bg-card p-4', STRIPES[post.impact])}>
      <div className="grid gap-0.5">
        <h3 className="font-semibold">{post.title}</h3>
        {post.starts !== null && post.ends !== null && (
          <p className="text-sm text-muted-foreground">
            {post.phase === 'upcoming' ? 'Scheduled for' : 'From'} <Time at={post.starts} /> to <Time at={post.ends} />
          </p>
        )}
      </div>
      <ol className="grid gap-3">
        {post.updates.map((u, i) => (
          <li key={i} className="grid gap-1">
            <p className="text-sm">
              <span className="font-medium">{stateLabel(u.state, post.impact)}</span>
              <span className="text-muted-foreground">
                {' '}
                · <Time at={u.at} />
              </span>
            </p>
            <Markdown text={u.message} />
          </li>
        ))}
      </ol>
    </article>
  )
}

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

const RED = 'border-red-500/40 bg-red-500/10'
const AMBER = 'border-amber-500/40 bg-amber-500/10'
const BLUE = 'border-sky-500/40 bg-sky-500/10'

// The worst of what the checks say and what's posted: a check down or a major outage, then some services affected,
// then maintenance going on; a notice changes nothing
function Summary({ checks, posts }: { checks: Page['checks']; posts: Post[] }) {
  const down = checks.filter((c) => c.status === 'failing')
  const open = (impact: Post['impact']) =>
    posts.some((p) => p.impact === impact && p.phase !== 'past' && p.phase !== 'upcoming')
  const [text, tone] = down.length
    ? [down.length === 1 ? `${down[0].name} is down` : `${down.length} services are down`, RED]
    : open('major')
      ? ['Major outage', RED]
      : open('minor')
        ? ['Some services are affected', AMBER]
        : open('maintenance')
          ? ['Maintenance in progress', BLUE]
          : checks.some((c) => c.status === 'ok') || !checks.length
            ? [checks.length ? 'Everything is up' : 'No known issues', 'border-emerald-500/40 bg-emerald-500/10']
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
  // Open first by how much they affect, an outage before maintenance before a notice
  const current = page.posts
    .filter((p) => p.phase === 'open' || p.phase === 'ongoing')
    .sort((a, b) => RANK.indexOf(a.impact) - RANK.indexOf(b.impact))
  const upcoming = page.posts.filter((p) => p.phase === 'upcoming').reverse()
  const past = page.posts.filter((p) => p.phase === 'past')
  return (
    <main className="min-h-dvh bg-muted/40 px-4 py-10">
      <div className="mx-auto grid max-w-2xl gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">{page.name} status</h1>
        <Summary checks={page.checks} posts={page.posts} />
        {current.map((p) => (
          <PostCard key={p.id} post={p} />
        ))}
        {upcoming.length > 0 && (
          <section className="grid gap-3">
            <h2 className="font-semibold">Scheduled maintenance</h2>
            {upcoming.map((p) => (
              <PostCard key={p.id} post={p} />
            ))}
          </section>
        )}
        {page.checks.length > 0 && (
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
        )}
        {past.length > 0 && (
          <section className="grid gap-3">
            <h2 className="font-semibold">Past updates</h2>
            {past.map((p) => (
              <PostCard key={p.id} post={p} />
            ))}
          </section>
        )}
        {page.checks.length > 0 && (
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
        )}
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
