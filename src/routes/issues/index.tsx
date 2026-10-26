import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { IconConfetti, IconSearch } from '@tabler/icons-react'
import { useState } from 'react'
import { Ago, count, Level, Sparkline } from '@/components/bits'
import { TimeChart } from '@/components/charts'
import { IssueActions } from '@/components/issue-actions'
import { SearchBar } from '@/components/search-bar'
import { Empty, PageHeader, Shell, useProjects } from '@/components/shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ValueMenu } from '@/components/value-menu'
import { CHART_DAYS, type ChartDays } from '@/data/charts'
import { getIssueChart, getIssues } from '@/fns'
import { addValue, NEW_FOR, tokenize, withToken } from '@/search/query'

const SORTS = { lastSeen: 'Last seen', firstSeen: 'First seen', events: 'Events', users: 'Users' } as const
type Search = { project?: string; query?: string; sort?: keyof typeof SORTS; page?: number; days?: ChartDays }
const DEFAULT_QUERY = 'is:unresolved'
const DEFAULT_DAYS = 14

export const Route = createFileRoute('/issues/')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
    query: typeof s.query === 'string' ? s.query : undefined,
    sort: typeof s.sort === 'string' && s.sort in SORTS ? (s.sort as Search['sort']) : undefined,
    page: Number(s.page) > 0 ? Number(s.page) : undefined,
    days:
      CHART_DAYS.includes(Number(s.days) as ChartDays) && Number(s.days) !== DEFAULT_DAYS
        ? (Number(s.days) as ChartDays)
        : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const query = deps.query ?? DEFAULT_QUERY
    const [list, chart] = await Promise.all([
      getIssues({ data: { project: deps.project, query, sort: deps.sort, page: deps.page ?? 0 } }),
      getIssueChart({ data: { project: deps.project, query, days: deps.days ?? DEFAULT_DAYS } }),
    ])
    return { ...list, chart }
  },
  head: () => ({ meta: [{ title: 'Issues · crashyard' }] }),
  component: Issues,
})

const STATUSES = [
  ['unresolved', 'Unresolved'],
  ['resolved', 'Resolved'],
  ['ignored', 'Ignored'],
  [undefined, 'All'],
] as const

function Issues() {
  const search = Route.useSearch()
  const { issues, more, now, chart } = Route.useLoaderData()
  const projects = useProjects()
  const navigate = useNavigate({ from: Route.fullPath })
  const query = search.query ?? DEFAULT_QUERY
  const status = tokenize(query).find((t) => t.key === 'is' && !t.negate)?.value
  const project = projects.find((p) => p.slug === search.project)
  const name = project?.name ?? search.project
  const [selected, setSelected] = useState<number[]>([])
  const go = (change: Partial<Search>) => {
    setSelected([])
    void navigate({ search: (s) => ({ ...s, page: undefined, ...change }) })
  }
  const chosen = issues.filter((i) => selected.includes(i.id))
  const oneProject = new Set(chosen.map((i) => i.project_id)).size === 1
  return (
    <Shell wide crumbs={name ? [<Link to="/issues">Issues</Link>, name] : ['Issues']}>
      <PageHeader title="Issues">{project?.name}</PageHeader>
      <div className="mb-3">
        <SearchBar
          scope="issues"
          query={query}
          project={search.project}
          placeholder='is:unresolved release:1.0.1 device:iPad* "audio engine"'
          onSearch={(q) => go({ query: q })}
        />
      </div>
      <section className="mb-3 rounded-xl border p-3 pb-1" aria-label="Events per day">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-sm">
            <span className="font-medium tabular-nums">{count(total(chart.series))}</span>{' '}
            <span className="text-muted-foreground">
              events in {chart.days.length} days
              {chart.previous.some(Boolean) && (
                <span className="max-sm:hidden">
                  , {count(chart.previous.reduce((a, b) => a + b, 0))} in the period before
                </span>
              )}
            </span>
          </p>
          <Select
            value={String(search.days ?? DEFAULT_DAYS)}
            onValueChange={(v) =>
              void navigate({
                search: (s) => ({ ...s, days: Number(v) === DEFAULT_DAYS ? undefined : (Number(v) as ChartDays) }),
              })
            }
          >
            <SelectTrigger size="sm" className="w-32" aria-label="Period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {CHART_DAYS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d} days
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <TimeChart
          x={chart.days}
          series={chart.series.map((s) => ({ key: s.level, label: s.level, values: s.counts }))}
          previous={chart.previous}
          className="h-30 md:h-50"
        />
      </section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex rounded-lg bg-muted p-0.5" role="tablist" aria-label="Status">
          {STATUSES.map(([value, label]) => (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={status === value}
              onClick={() => go({ query: withToken(query, 'is', value) })}
              className="rounded-md px-2.5 py-1 text-sm text-muted-foreground aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-sm"
            >
              {label}
            </button>
          ))}
        </div>
        <Select
          value={search.sort ?? 'lastSeen'}
          onValueChange={(v) => go({ sort: v === 'lastSeen' ? undefined : (v as Search['sort']) })}
        >
          <SelectTrigger size="sm" className="w-36" aria-label="Sort by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {Object.entries(SORTS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {selected.length > 0 && (
        <div className="sticky top-14 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-xl border bg-background p-2 pl-3 shadow-sm">
          <span className="text-sm font-medium">{selected.length} selected</span>
          <IssueActions
            ids={selected}
            size="sm"
            status={status === 'resolved' || status === 'ignored' ? status : undefined}
            canMerge={selected.length > 1 && oneProject}
            onDone={() => setSelected([])}
          />
        </div>
      )}
      {issues.length === 0 ? (
        query === DEFAULT_QUERY ? (
          <Empty icon={IconConfetti} title="Nothing unresolved">
            Not a single open issue. Enjoy it while it lasts: new crashes and errors land here the moment an app sends
            them.
          </Empty>
        ) : (
          <Empty icon={IconSearch} title="No issues match">
            Try fewer terms, a longer period or another status.
          </Empty>
        )
      ) : (
        <ul className="divide-y rounded-xl border">
          <li className="flex items-center gap-3 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <Checkbox
              aria-label="Select every issue on this page"
              checked={selected.length === issues.length ? true : selected.length ? 'indeterminate' : false}
              onCheckedChange={(c) => setSelected(c === true ? issues.map((i) => i.id) : [])}
            />
            <span className="flex-1">Issue</span>
            <span className="w-24 text-center max-md:hidden">14 days</span>
            <span className="w-14 text-right">Events</span>
            <span className="w-12 text-right max-sm:hidden">Users</span>
          </li>
          {issues.map((i) => (
            <li key={i.id} className="relative flex items-center gap-3 px-3 py-3 hover:bg-muted/40">
              <Checkbox
                className="relative z-10"
                aria-label={`Select ${i.title}`}
                checked={selected.includes(i.id)}
                onCheckedChange={(c) => setSelected((s) => (c === true ? [...s, i.id] : s.filter((x) => x !== i.id)))}
              />
              <div className="min-w-0 flex-1">
                {/* The whole row opens the issue; the checkbox and the values' menus sit above the link */}
                <Link
                  to="/issues/$issueId"
                  params={{ issueId: String(i.id) }}
                  className="flex items-center gap-2 outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
                >
                  <Level level={i.level} />
                  <span className="truncate text-sm font-medium">{i.title}</span>
                </Link>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  {!project && (
                    <ValueMenu
                      field="project"
                      value={i.project}
                      onInclude={() => go({ query: addValue(query, 'project', i.project, false) })}
                      onExclude={() => go({ query: addValue(query, 'project', i.project, true) })}
                      className="font-medium text-foreground/70"
                    >
                      {i.project}
                    </ValueMenu>
                  )}
                  {i.last_release && (
                    <ValueMenu
                      field="release"
                      value={i.last_release}
                      onInclude={() => go({ query: addValue(query, 'release', i.last_release!, false) })}
                      onExclude={() => go({ query: addValue(query, 'release', i.last_release!, true) })}
                      className="font-mono text-[0.7rem]"
                    >
                      {i.last_release}
                    </ValueMenu>
                  )}
                  {i.culprit && <span className="max-w-full truncate font-mono text-[0.7rem]">{i.culprit}</span>}
                  <span>
                    <Ago at={i.last_seen} now={now} /> · first seen <Ago at={i.first_seen} now={now} />
                  </span>
                  {i.status === 'unresolved' && i.substatus === 'new' && i.first_seen > now - NEW_FOR && (
                    <Badge variant="secondary">New</Badge>
                  )}
                  {i.status === 'unresolved' && i.substatus === 'regressed' && (
                    <Badge variant="destructive">Regressed</Badge>
                  )}
                  {i.status === 'resolved' && <Badge variant="outline">Resolved</Badge>}
                  {i.status === 'ignored' && <Badge variant="outline">Ignored</Badge>}
                </p>
              </div>
              <Sparkline values={i.series} className="max-md:hidden" />
              <span className="w-14 text-right text-sm tabular-nums">{count(i.count)}</span>
              <span className="w-12 text-right text-sm text-muted-foreground tabular-nums max-sm:hidden">
                {count(i.user_count)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {(more || (search.page ?? 0) > 0) && (
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!search.page}
            onClick={() => go({ page: (search.page ?? 1) - 1 || undefined })}
          >
            Newer
          </Button>
          <Button variant="outline" size="sm" disabled={!more} onClick={() => go({ page: (search.page ?? 0) + 1 })}>
            Older
          </Button>
        </div>
      )}
    </Shell>
  )
}

const total = (series: { counts: number[] }[]) =>
  series.reduce((sum, s) => sum + s.counts.reduce((a, b) => a + b, 0), 0)
