import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { Ago, count, Level, percent } from '@/components/bits'
import { PageHeader, Shell } from '@/components/shell'
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
        <h2 className="font-mono text-lg font-semibold break-all">{d.release.release}</h2>
        <p className="text-sm text-muted-foreground">
          {count(d.release.events)} events in {count(d.release.issues)} issues · first seen{' '}
          <Ago at={d.release.first} now={d.now} />
          {d.previous && <> · compared with {d.previous}</>}
          {d.sessions && d.crashFree !== null && (
            <>
              {' '}
              · {percent(d.crashFree)} crash-free across {count(d.sessions.started)} sessions
            </>
          )}
        </p>
      </div>
      <div className="grid gap-6 *:min-w-0">
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
