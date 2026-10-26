import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { Ago, count, Level, percent } from '@/components/bits'
import { TimeChart } from '@/components/charts'
import { HealthBadge } from '@/components/release'
import { PageHeader, Shell } from '@/components/shell'
import { Time } from '@/components/time'
import { Badge } from '@/components/ui/badge'
import { getRelease } from '@/fns'

export const Route = createFileRoute('/projects/$slug/releases/$release')({
  loader: async ({ params }) => {
    const data = await getRelease({ data: { slug: params.slug, release: params.release } })
    if (!data) throw notFound()
    return data
  },
  head: ({ params }) => ({ meta: [{ title: `${params.release} · crashyard` }] }),
  component: Release,
})

type Data = NonNullable<Awaited<ReturnType<typeof getRelease>>>

function Release() {
  const d = Route.useLoaderData()
  return (
    <Shell
      crumbs={[
        <Link to="/releases">Releases</Link>,
        <Link to="/releases" search={{ project: d.project.slug }}>
          {d.project.name}
        </Link>,
        d.release.release,
      ]}
    >
      <PageHeader title="Releases">{d.project.name}</PageHeader>
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-mono text-lg font-semibold break-all">{d.release.release}</h2>
          {d.healthy && <HealthBadge {...d.healthy} />}
        </div>
        <p className="text-sm text-muted-foreground">
          {count(d.release.events)} events in {count(d.release.issues)} issues · first seen{' '}
          <Ago at={d.release.first} now={d.now} />
          {d.previous && <> · compared with {d.previous}</>}
        </p>
      </div>
      {d.health && <Health health={d.health} adoption={d.adoption} />}
      <div className="grid gap-6 *:min-w-0">
        {d.deploys.length > 0 && <Deploys deploys={d.deploys} />}
        {d.commits.length > 0 && <Commits commits={d.commits} now={d.now} />}
        <Group title="New in this release" issues={d.fresh} empty="No new issues. A clean release so far." />
        <Group title="Regressed" issues={d.regressed} empty="Nothing resolved has come back." />
        {d.previous && (
          <Group
            title={`Gone since ${d.previous}`}
            issues={d.gone}
            empty={`Every issue from ${d.previous} still happens in this release.`}
            note={`Issues seen in ${d.previous} that haven’t appeared in this release yet`}
          />
        )}
        <Group title="Still happening" issues={d.ongoing} empty="No other issues in this release." />
      </div>
    </Shell>
  )
}

function Health({ health: h, adoption }: { health: NonNullable<Data['health']>; adoption: Data['adoption'] }) {
  const stats = [
    ['Crash-free sessions', h.crashFree === null ? '–' : percent(h.crashFree)],
    ['Crash-free users', h.crashFreeUsers === null ? '–' : percent(h.crashFreeUsers)],
    ['Sessions in 24 hours', count(h.sessions24h)],
    ['Active users in 24 hours', count(h.users24h)],
    ['Adoption', h.adoption === null ? '–' : percent(h.adoption)],
  ]
  return (
    <section className="mb-6 grid gap-3" aria-label="Release health">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-xl border p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="rounded-xl border p-3 pb-1">
        <p className="mb-2 text-sm text-muted-foreground">Share of each day’s sessions, the last 30 days</p>
        <TimeChart
          x={adoption.map((a) => a.day)}
          series={[
            {
              key: 'adoption',
              label: 'Adoption',
              values: adoption.map((a) => (a.adoption === null ? null : Math.round(a.adoption * 1000) / 10)),
              kind: 'line',
              color: 'var(--chart-1)',
            },
          ]}
          format={(v) => `${v}%`}
          className="h-32 md:h-40"
        />
      </div>
    </section>
  )
}

function Deploys({ deploys }: { deploys: Data['deploys'] }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">
        Deploys <span className="font-normal text-muted-foreground">{deploys.length}</span>
      </h3>
      <ul className="divide-y rounded-xl border text-sm">
        {deploys.map((dep) => (
          <li key={dep.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
            <Badge variant="outline">{dep.environment}</Badge>
            <span className="min-w-0 flex-1 truncate">
              {dep.url ? (
                <a href={dep.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                  {dep.name ?? dep.url}
                </a>
              ) : (
                (dep.name ?? '')
              )}
            </span>
            <Time at={dep.finished} className="text-xs text-muted-foreground" />
          </li>
        ))}
      </ul>
    </section>
  )
}

function Commits({ commits, now }: { commits: Data['commits']; now: number }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">
        Commits <span className="font-normal text-muted-foreground">{commits.length}</span>
      </h3>
      <ul className="divide-y rounded-xl border">
        {commits.map((c) => {
          const row = (
            <>
              <span className="min-w-0 flex-1 truncate text-sm">{c.message.split('\n')[0]}</span>
              <span className="hidden truncate text-xs text-muted-foreground sm:inline">{c.author}</span>
              {c.at && <Ago at={c.at} now={now} className="shrink-0 text-xs text-muted-foreground" />}
              <code className="shrink-0 font-mono text-xs text-muted-foreground">{c.sha.slice(0, 7)}</code>
            </>
          )
          return (
            <li key={c.sha}>
              {c.url ? (
                <a
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40"
                >
                  {row}
                </a>
              ) : (
                <div className="flex items-center gap-3 px-4 py-2.5">{row}</div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function Group({ title, issues, empty, note }: { title: string; issues: Data['fresh']; empty: string; note?: string }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">
        {title} <span className="font-normal text-muted-foreground">{issues.length || ''}</span>
      </h3>
      {note && <p className="-mt-1.5 mb-2 text-xs text-muted-foreground">{note}</p>}
      {issues.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {issues.map((i) => (
            <li key={i.id}>
              <Link
                to="/issues/$issueId"
                params={{ issueId: String(i.id) }}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40"
              >
                <Level level={i.level} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{i.title}</p>
                  {i.culprit && <p className="truncate font-mono text-xs text-muted-foreground">{i.culprit}</p>}
                </div>
                {i.status !== 'unresolved' && <Badge variant="outline">{i.status}</Badge>}
                <span className="text-sm tabular-nums">{count(i.count ?? 0)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
