import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router'
import { IconArrowRight, IconCompass } from '@tabler/icons-react'
import { Fragment, useState } from 'react'
import { count } from '@/components/bits'
import { PALETTE, TimeChart } from '@/components/charts'
import { SavedSearches, SearchBar } from '@/components/search-bar'
import { Empty, PageHeader, Shell, useProjects } from '@/components/shell'
import { Time } from '@/components/time'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { BUILT_IN, DEFAULT_COLUMNS, MAX_COLUMNS } from '@/data/explore'
import { getExplore, getSavedSearches } from '@/fns'
import { addValue, isSearchableKey } from '@/search/query'

const RANGES = { '1h': 'Last hour', '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' } as const
type Range = keyof typeof RANGES
type Search = {
  project?: string
  query?: string
  range?: Range
  columns?: string
  groupBy?: string
  users?: boolean
  before?: number
}

const NAME = /^[\w.:-]{1,60}$/
const columnsOf = (v?: string) =>
  v
    ? v
        .split(',')
        .map((c) => c.trim())
        .filter((c) => NAME.test(c))
        .slice(0, MAX_COLUMNS)
    : DEFAULT_COLUMNS

export const Route = createFileRoute('/explore')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
    // An empty query is kept: it's "everything", not the pinned search
    query: typeof s.query === 'string' ? s.query : undefined,
    range: typeof s.range === 'string' && s.range in RANGES && s.range !== '24h' ? (s.range as Range) : undefined,
    columns: typeof s.columns === 'string' && s.columns ? columnsOf(s.columns).join(',') : undefined,
    groupBy: typeof s.groupBy === 'string' && NAME.test(s.groupBy) ? s.groupBy : undefined,
    users: s.users === true || s.users === 'true' ? true : undefined,
    before: Number.isSafeInteger(Number(s.before)) && Number(s.before) > 0 ? Number(s.before) : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    // With no query in the URL, the viewer's pinned search opens
    const saved = await getSavedSearches({ data: { page: 'explore' } })
    const query = deps.query ?? saved.find((s) => s.pinned)?.query ?? ''
    const data = await getExplore({
      data: {
        project: deps.project,
        query,
        range: deps.range ?? '24h',
        columns: columnsOf(deps.columns),
        groupBy: deps.groupBy,
        aggregate: deps.users ? 'count_unique(user)' : 'count',
        before: deps.before,
      },
    })
    if (!data) throw notFound()
    return { ...data, saved, query }
  },
  head: () => ({ meta: [{ title: 'Explore · crashyard' }] }),
  component: Explore,
})

function Explore() {
  const d = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const projects = useProjects()
  const name = search.project && (projects.find((p) => p.slug === search.project)?.name ?? search.project)
  const go = (next: Partial<Search>) => void navigate({ search: (s) => ({ ...s, before: undefined, ...next }) })
  const [columnsText, setColumnsText] = useState(d.columns.join(', '))
  const groupChoices = [...new Set([...BUILT_IN, ...d.columns])]
  const total = d.chart.series.reduce((a, s) => a + s.values.reduce((x, y) => x + y, 0), 0)
  const what = search.users ? 'Users' : 'Events'
  return (
    <Shell wide crumbs={name ? [<Link to="/explore">Explore</Link>, name] : ['Explore']}>
      <PageHeader title="Explore">{name}</PageHeader>
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="min-w-60 flex-1">
          <SearchBar
            scope="events"
            query={d.query}
            project={search.project}
            placeholder='device:iPad* release:1.2 "audio engine"'
            onSearch={(q) => go({ query: q })}
          />
        </div>
        <SavedSearches page="explore" query={d.query} searches={d.saved} onPick={(q) => go({ query: q })} />
        <Select
          value={search.range ?? '24h'}
          onValueChange={(v) => go({ range: v === '24h' ? undefined : (v as Range) })}
        >
          <SelectTrigger className="w-40" aria-label="Time range">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {Object.entries(RANGES).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_12rem_10rem]">
        <form
          className="grid gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            const list = columnsOf(columnsText)
            go({ columns: list.join(',') === DEFAULT_COLUMNS.join(',') ? undefined : list.join(',') })
          }}
        >
          <Label htmlFor="explore-columns">Columns</Label>
          <Input
            id="explore-columns"
            value={columnsText}
            onChange={(e) => setColumnsText(e.target.value)}
            onBlur={(e) => e.currentTarget.form?.requestSubmit()}
            placeholder="level, release, device"
            autoComplete="off"
          />
        </form>
        <div className="grid gap-1.5">
          <Label htmlFor="explore-group">Group by</Label>
          <Select value={search.groupBy ?? 'none'} onValueChange={(v) => go({ groupBy: v === 'none' ? undefined : v })}>
            <SelectTrigger id="explore-group" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Nothing</SelectItem>
              {groupChoices.map((g) => (
                <SelectItem key={g} value={g}>
                  {g}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="explore-count">Count</Label>
          <Select
            value={search.users ? 'users' : 'events'}
            onValueChange={(v) => go({ users: v === 'users' || undefined })}
          >
            <SelectTrigger id="explore-count" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="events">Events</SelectItem>
              <SelectItem value="users">Users</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <section className="mb-4 rounded-xl border p-3 pb-1" aria-label={`${what} over time`}>
        <p className="mb-2 text-sm text-muted-foreground">
          {what} over time{search.groupBy ? ` by ${search.groupBy}` : ''}
          {search.groupBy && d.chart.groups.length >= 10 ? ', the 10 biggest' : ''}
          {search.users && ' · a user counts once in each bar'}
        </p>
        <TimeChart
          x={d.chart.x}
          series={d.chart.series.map((s, i) => ({
            key: `g${i}`,
            label: search.groupBy ? s.key || 'none' : what,
            values: s.values,
            color: search.groupBy ? PALETTE[i % PALETTE.length] : 'var(--chart-1)',
          }))}
          legend={!!search.groupBy}
          className="h-36 md:h-44"
        />
      </section>

      {search.groupBy && d.chart.groups.length > 0 && (
        <section className="mb-4" aria-label={`By ${search.groupBy}`}>
          <ul className="divide-y rounded-xl border text-sm">
            {d.chart.groups.map((g, i) => (
              <li key={g.value} className="flex items-center gap-3 px-3 py-2">
                <span className="size-2 shrink-0 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />
                {isSearchableKey(search.groupBy!) && g.value ? (
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left font-mono text-xs hover:underline"
                    onClick={() =>
                      go({ query: addValue(d.query, search.groupBy!, g.value, false), groupBy: undefined })
                    }
                  >
                    {g.value}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{g.value || 'none'}</span>
                )}
                <span className="tabular-nums">{count(g.v)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.rows.length === 0 ? (
        <Empty icon={IconCompass} title="No events match">
          {total === 0
            ? 'Nothing in this range. Widen the range or change the search.'
            : 'Try a wider range or fewer filters.'}
        </Empty>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28 max-sm:hidden">Received</TableHead>
                <TableHead>Issue</TableHead>
                {/* Narrower than md, the columns are pairs under each row's issue */}
                {d.columns.map((c) => (
                  <TableHead key={c} className="max-md:hidden">
                    {c}
                  </TableHead>
                ))}
                <TableHead className="w-12">
                  <span className="sr-only">Open issue</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs whitespace-nowrap text-muted-foreground max-sm:hidden">
                    <Time at={r.received} />
                  </TableCell>
                  <TableCell className="max-w-0 min-w-40">
                    <p className="truncate">{r.title}</p>
                    <Time at={r.received} className="text-xs text-muted-foreground sm:hidden" />
                    <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-xs md:hidden">
                      {r.values.map((v, i) => (
                        <Fragment key={d.columns[i]}>
                          <dt className="text-muted-foreground">{d.columns[i]}</dt>
                          <dd className="truncate font-mono">{v ?? '–'}</dd>
                        </Fragment>
                      ))}
                    </dl>
                  </TableCell>
                  {r.values.map((v, i) => (
                    <TableCell key={d.columns[i]} className="max-w-48 truncate font-mono text-xs max-md:hidden">
                      {v ?? <span className="text-muted-foreground">–</span>}
                    </TableCell>
                  ))}
                  <TableCell>
                    <Button variant="ghost" size="icon" asChild>
                      <Link
                        to="/issues/$issueId"
                        params={{ issueId: String(r.issue_id) }}
                        search={{ event: r.id }}
                        aria-label="Open issue"
                      >
                        <IconArrowRight />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {d.older && (
        <div className="mt-3 flex justify-center">
          <Button variant="outline" onClick={() => go({ before: d.older! })}>
            Show older events
          </Button>
        </div>
      )}
    </Shell>
  )
}
