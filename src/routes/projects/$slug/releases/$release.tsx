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
          {count(d.release.events)} events in {count(d.release.issues)} issues · first{' '}
          <Ago at={d.release.first} now={d.now} />
          {d.previous && <> · against {d.previous}</>}
          {d.sessions && d.crashFree !== null && (
            <>
              {' '}
              · {percent(d.crashFree)} crash-free sessions ({count(d.sessions.started)})
            </>
          )}
        </p>
      </div>
      <div className="grid gap-6 *:min-w-0">
        <Group title="New in this release" issues={d.fresh} empty="Nothing new." />
        <Group title="Came back" issues={d.regressed} empty="Nothing came back." />
        {d.previous && (
          <Group
            title={`Gone since ${d.previous}`}
            issues={d.gone}
            empty={`Everything seen in ${d.previous} still happens.`}
            note="Seen in the release before, not in this one, so far"
          />
        )}
        <Group title="Still happening" issues={d.ongoing} empty="Nothing else." />
      </div>
    </Shell>
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
