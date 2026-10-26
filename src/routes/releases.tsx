import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router'
import { IconTag } from '@tabler/icons-react'
import { Ago, count, percent } from '@/components/bits'
import { AdoptionStage } from '@/components/release'
import { Empty, PageHeader, Shell } from '@/components/shell'
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
  const navigate = useNavigate({ from: Route.fullPath })
  const name = project && (sections[0]?.project.name ?? project)
  const shown = sections.filter((s) => s.releases.length > 0)
  // Highest first; a release without the number goes last
  const sorted = (list: (typeof shown)[number]['releases']) =>
    sort === 'newest' ? list : [...list].sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1))
  return (
    <Shell crumbs={name ? [<Link to="/releases">Releases</Link>, name] : ['Releases']}>
      <PageHeader
        title="Releases"
        actions={
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
          <section key={p.id}>
            {!project && <h2 className="mb-2 text-sm font-medium text-muted-foreground">{p.name}</h2>}
            <ul className="divide-y rounded-xl border">
              {sorted(releases).map((r) => (
                <li key={r.release}>
                  <Link
                    to="/projects/$slug/releases/$release"
                    params={{ slug: p.slug, release: r.release }}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2">
                        <span className="truncate font-mono text-sm font-medium">{r.release}</span>
                        {r.stage && <AdoptionStage stage={r.stage} />}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        First seen <Ago at={r.first} now={now} /> · last seen <Ago at={r.last} now={now} />
                      </p>
                    </div>
                    <dl className="hidden gap-6 text-right text-sm tabular-nums md:flex">
                      <Stat label="Adoption" value={r.adoption === null ? '–' : percent(r.adoption)} />
                      <Stat label="Sessions" value={count(r.sessions)} />
                      <Stat label="Users" value={count(r.users)} />
                      <Stat
                        label="Crash-free users"
                        value={r.crashFreeUsers === null ? '–' : percent(r.crashFreeUsers)}
                      />
                    </dl>
                    <div className="text-right text-sm tabular-nums">
                      <p>{count(r.issues)} issues</p>
                      <p className="text-xs text-muted-foreground">
                        {r.crashFree !== null ? `${percent(r.crashFree)} crash-free` : `${count(r.events)} events`}
                      </p>
                      {r.adoption !== null && (
                        <p className="text-xs text-muted-foreground md:hidden">{percent(r.adoption)} adoption</p>
                      )}
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="w-24">
      <dt className="text-xs whitespace-nowrap text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
