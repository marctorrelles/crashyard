import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { Ago, count, percent } from '@/components/bits'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { getReleases } from '@/fns'

export const Route = createFileRoute('/projects/$slug/releases/')({
  loader: async ({ params }) => {
    const data = await getReleases({ data: { slug: params.slug } })
    if (!data) throw notFound()
    return data
  },
  head: ({ loaderData }) => ({ meta: [{ title: `Releases · ${loaderData?.project.name} · crashyard` }] }),
  component: Releases,
})

function Releases() {
  const { project, releases, now } = Route.useLoaderData()
  return (
    <Shell>
      <PageHeader title="Releases">{project.name}</PageHeader>
      {releases.length === 0 ? (
        <Empty title="No releases yet">Events that name a release (the SDKs' `release` option) show up here.</Empty>
      ) : (
        <ul className="divide-y rounded-xl border">
          {releases.map((r) => (
            <li key={r.release}>
              <Link
                to="/projects/$slug/releases/$release"
                params={{ slug: project.slug, release: r.release }}
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
      )}
    </Shell>
  )
}
