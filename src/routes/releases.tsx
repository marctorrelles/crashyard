import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router'
import { IconTag } from '@tabler/icons-react'
import { useState } from 'react'
import { Ago, count, Pager, percent } from '@/components/bits'
import { AdoptionStage } from '@/components/release'
import { Empty, PageHeader, Shell, useProjects } from '@/components/shell'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getReleases } from '@/fns'

const SORTS = {
  newest: 'Newest',
  sessions: 'Sessions',
  users: 'Users',
  adoption: 'Adoption',
  crashFree: 'Crash-free sessions',
  crashFreeUsers: 'Crash-free users',
} as const
type Sort = keyof typeof SORTS
type Search = { project?: string; sort?: Sort }
// Releases a page, in each project's list
const PAGE = 10

export const Route = createFileRoute('/releases')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
    sort: typeof s.sort === 'string' && s.sort in SORTS && s.sort !== 'newest' ? (s.sort as Sort) : undefined,
  }),
  loaderDeps: ({ search }) => ({ project: search.project }),
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
  const { project, sort = 'newest' } = Route.useSearch()
  const projects = useProjects()
  const navigate = useNavigate({ from: Route.fullPath })
  const name = project && (sections[0]?.project.name ?? project)
  const shown = sections.filter((s) => s.releases.length > 0)
  return (
    <Shell crumbs={name ? [<Link to="/releases">Releases</Link>, name] : ['Releases']}>
      <PageHeader
        title="Releases"
        actions={
          <>
            <Select
              value={project ?? 'all'}
              onValueChange={(v) => void navigate({ search: (s) => ({ ...s, project: v === 'all' ? undefined : v }) })}
            >
              <SelectTrigger aria-label="Project" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.slug}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={sort}
              onValueChange={(v) =>
                void navigate({ search: (s) => ({ ...s, sort: v === 'newest' ? undefined : (v as Sort) }) })
              }
            >
              <SelectTrigger aria-label="Sort by" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(SORTS).map(([key, label]) => (
                  <SelectItem key={key} value={key}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      >
        {name}
      </PageHeader>
      {shown.length === 0 && (
        <Empty icon={IconTag} title="No releases yet">
          Releases appear once events name one. Most SDKs set the release for you. Otherwise, set the release option.
        </Empty>
      )}
      <div className="grid gap-8">
        {shown.map(({ project: p, releases }) => (
          // A new sort starts each list on its first page
          <ReleaseList
            key={`${p.id} ${sort}`}
            project={p}
            releases={releases}
            sort={sort}
            now={now}
            titled={!project}
          />
        ))}
      </div>
    </Shell>
  )
}

type Section = NonNullable<Awaited<ReturnType<typeof getReleases>>>['sections'][number]

// The columns every row shares, so each value sits under the one above it whatever the release's name and badge:
// the release, then on a desktop adoption, sessions, users and crash-free users, then issues and crash-free sessions
const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_repeat(4,6.5rem)_9rem]'

/** A project's releases, sorted and paged */
function ReleaseList({
  project: p,
  releases,
  sort,
  now,
  titled,
}: Section & { sort: Sort; now: number; titled: boolean }) {
  const [page, setPage] = useState(0)
  // Highest first; a release without the number goes last
  const sorted = sort === 'newest' ? releases : [...releases].sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1))
  const pages = Math.ceil(sorted.length / PAGE)
  return (
    <section className="grid gap-2">
      {titled && <h2 className="text-sm font-medium text-muted-foreground">{p.name}</h2>}
      <ul className="divide-y rounded-xl border">
        {sorted.slice(page * PAGE, page * PAGE + PAGE).map((r) => (
          <li key={r.release}>
            <Link
              to="/projects/$slug/releases/$release"
              params={{ slug: p.slug, release: r.release }}
              className={`${COLUMNS} items-center gap-3 px-4 py-3 hover:bg-muted/40`}
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2">
                  <span className="truncate font-mono text-sm font-medium">{r.release}</span>
                  {r.stage && <AdoptionStage stage={r.stage} />}
                </p>
                <p className="text-xs text-muted-foreground">
                  First seen <Ago at={r.first} now={now} /> · last seen <Ago at={r.last} now={now} />
                </p>
              </div>
              <Stat label="Adoption" value={r.adoption === null ? '–' : percent(r.adoption)} />
              <Stat label="Sessions" value={count(r.sessions)} />
              <Stat label="Users" value={count(r.users)} />
              <Stat label="Crash-free users" value={r.crashFreeUsers === null ? '–' : percent(r.crashFreeUsers)} />
              <div className="text-right text-sm tabular-nums">
                <p>
                  {count(r.issues)} {r.issues === 1 ? 'issue' : 'issues'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {r.crashFree !== null
                    ? `${percent(r.crashFree)} crash-free`
                    : `${count(r.events)} ${r.events === 1 ? 'event' : 'events'}`}
                </p>
                {r.adoption !== null && (
                  <p className="text-xs text-muted-foreground md:hidden">{percent(r.adoption)} adoption</p>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
      <Pager page={page} pages={pages} onPage={setPage} />
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <dl className="text-right text-sm tabular-nums max-md:hidden">
      <dt className="text-xs whitespace-nowrap text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </dl>
  )
}
