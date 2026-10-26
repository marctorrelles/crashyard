import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { Ago, count, percent } from '@/components/bits'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { getReleases } from '@/fns'

type Search = { project?: string }

export const Route = createFileRoute('/releases')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const data = await getReleases({ data: { slug: deps.project } })
    if (!data) throw notFound()
    return data
  },
  head: () => ({ meta: [{ title: 'Releases · crashyard' }] }),
  component: Releases,
})

function Releases() {
  const { sections, now } = Route.useLoaderData()
  const { project } = Route.useSearch()
  const name = project && (sections[0]?.project.name ?? project)
  const shown = sections.filter((s) => s.releases.length > 0)
  return (
    <Shell crumbs={name ? [<Link to="/releases">Releases</Link>, name] : ['Releases']}>
      <PageHeader title="Releases">{name}</PageHeader>
      {shown.length === 0 && (
        <Empty title="No releases yet">Events that name a release (the SDKs' `release` option) show up here.</Empty>
      )}
      <div className="grid gap-8">
        {shown.map(({ project: p, releases }) => (
          <section key={p.id}>
            {!project && <h2 className="mb-2 text-sm font-medium text-muted-foreground">{p.name}</h2>}
            <ul className="divide-y rounded-xl border">
              {releases.map((r) => (
                <li key={r.release}>
                  <Link
                    to="/projects/$slug/releases/$release"
                    params={{ slug: p.slug, release: r.release }}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-sm font-medium">{r.release}</p>
                      <p className="text-xs text-muted-foreground">
                        first <Ago at={r.first} now={now} /> · last <Ago at={r.last} now={now} />
                      </p>
                    </div>
                    <div className="text-right text-sm tabular-nums">
                      <p>{count(r.issues)} issues</p>
                      <p className="text-xs text-muted-foreground">
                        {r.crashFree !== null ? `${percent(r.crashFree)} crash-free` : `${count(r.events)} events`}
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Shell>
  )
}
