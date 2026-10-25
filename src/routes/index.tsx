import { createFileRoute, Link } from '@tanstack/react-router'
import { Ago, count, Level, Sparkline } from '@/components/bits'
import { NewProject, PLATFORM_NAMES } from '@/components/new-project'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { getOverview } from '@/fns'

export const Route = createFileRoute('/')({
  loader: async () => ({ ...(await getOverview()), now: Date.now() }),
  component: Home,
})

function Home() {
  const { projects, newIssues, failing, now } = Route.useLoaderData()
  return (
    <Shell>
      <PageHeader title="Projects" actions={projects.length > 0 && <NewProject variant="outline" />} />
      {projects.length === 0 ? (
        <Empty title="No projects yet">
          <p className="mb-4">Make one for each app, then point its Sentry SDK at the DSN it gets.</p>
          <NewProject />
        </Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Link
              key={p.id}
              to="/issues"
              search={{ project: p.slug }}
              className="group rounded-xl border bg-card p-4 transition-colors hover:border-foreground/20"
            >
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="truncate font-medium">{p.name}</h2>
                <span className="shrink-0 text-xs text-muted-foreground">{PLATFORM_NAMES[p.platform]}</span>
              </div>
              <div className="mt-3 flex items-end justify-between gap-3">
                <dl className="flex gap-5 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Unresolved</dt>
                    <dd className="text-lg font-semibold tabular-nums">{count(p.unresolved)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Events, 24h</dt>
                    <dd className="text-lg font-semibold tabular-nums">{count(p.today)}</dd>
                  </div>
                </dl>
                <Sparkline values={p.series} className="h-8 w-28" />
              </div>
            </Link>
          ))}
        </div>
      )}
      {failing.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">Monitors failing</h2>
          <ul className="divide-y rounded-xl border border-red-500/30">
            {failing.map((m) => (
              <li key={m.id}>
                <Link
                  to="/monitors/$monitorId"
                  params={{ monitorId: String(m.id) }}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50"
                >
                  <span className="size-2 shrink-0 rounded-full bg-red-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{m.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {m.project} · {m.reason}
                    </p>
                  </div>
                  {m.since && <Ago at={m.since} now={now} className="text-xs text-muted-foreground" />}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {newIssues.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">New in the last day</h2>
          <ul className="divide-y rounded-xl border">
            {newIssues.map((i) => (
              <li key={i.id}>
                <Link
                  to="/issues/$issueId"
                  params={{ issueId: String(i.id) }}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50"
                >
                  <Level level={i.level} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{i.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {i.project} · {i.culprit || 'no culprit'}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-xs text-muted-foreground">
                    <p className="tabular-nums">
                      {count(i.count)} {i.count === 1 ? 'event' : 'events'}
                    </p>
                    <Ago at={i.first_seen} now={now} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Shell>
  )
}
