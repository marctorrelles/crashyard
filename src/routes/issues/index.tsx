import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { SearchIcon } from 'lucide-react'
import { useState } from 'react'
import { Ago, count, Level, Sparkline } from '@/components/bits'
import { IssueActions } from '@/components/issue-actions'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getIssues, getProjects } from '@/fns'
import { NEW_FOR, tokenize, withToken } from '@/search/query'

const SORTS = { lastSeen: 'Last seen', firstSeen: 'First seen', events: 'Events', users: 'Users' } as const
type Search = { project?: string; query?: string; sort?: keyof typeof SORTS; page?: number }
const DEFAULT_QUERY = 'is:unresolved'

export const Route = createFileRoute('/issues/')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
    query: typeof s.query === 'string' ? s.query : undefined,
    sort: typeof s.sort === 'string' && s.sort in SORTS ? (s.sort as Search['sort']) : undefined,
    page: Number(s.page) > 0 ? Number(s.page) : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const [list, projects] = await Promise.all([
      getIssues({
        data: { project: deps.project, query: deps.query ?? DEFAULT_QUERY, sort: deps.sort, page: deps.page ?? 0 },
      }),
      getProjects(),
    ])
    return { ...list, projects }
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
  const { issues, more, now, projects } = Route.useLoaderData()
  const navigate = useNavigate({ from: Route.fullPath })
  const query = search.query ?? DEFAULT_QUERY
  const status = tokenize(query).find((t) => t.key === 'is' && !t.negate)?.value
  const project = projects.find((p) => p.slug === search.project)
  const [selected, setSelected] = useState<number[]>([])
  const go = (change: Partial<Search>) => {
    setSelected([])
    void navigate({ search: (s) => ({ ...s, page: undefined, ...change }) })
  }
  const chosen = issues.filter((i) => selected.includes(i.id))
  const oneProject = new Set(chosen.map((i) => i.project_id)).size === 1
  return (
    <Shell wide>
      <PageHeader
        title="Issues"
        actions={
          <Select value={search.project ?? '*'} onValueChange={(v) => go({ project: v === '*' ? undefined : v })}>
            <SelectTrigger className="w-44" aria-label="Project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="*">Every project</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.slug} value={p.slug}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        {project?.name}
      </PageHeader>
      <form
        key={query}
        className="mb-3"
        onSubmit={(e) => {
          e.preventDefault()
          go({ query: String(new FormData(e.currentTarget).get('q')) })
        }}
      >
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            name="q"
            defaultValue={query}
            placeholder='is:unresolved release:1.0.1 device:iPad* "audio engine"'
            aria-label="Search issues"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
          />
        </InputGroup>
      </form>
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
        <Empty title={query === DEFAULT_QUERY ? 'Nothing unresolved' : 'No issues match'}>
          {query === DEFAULT_QUERY
            ? 'Crashes and errors your apps send show up here.'
            : 'Try fewer words, or another status.'}
        </Empty>
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
            <li key={i.id} className="flex items-center gap-3 px-3 py-3 hover:bg-muted/40">
              <Checkbox
                aria-label={`Select ${i.title}`}
                checked={selected.includes(i.id)}
                onCheckedChange={(c) => setSelected((s) => (c === true ? [...s, i.id] : s.filter((x) => x !== i.id)))}
              />
              <Link to="/issues/$issueId" params={{ issueId: String(i.id) }} className="min-w-0 flex-1">
                <p className="flex items-center gap-2">
                  <Level level={i.level} />
                  <span className="truncate text-sm font-medium">{i.title}</span>
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  {!project && <span className="font-medium text-foreground/70">{i.project}</span>}
                  {i.culprit && <span className="max-w-full truncate font-mono text-[0.7rem]">{i.culprit}</span>}
                  <span>
                    <Ago at={i.last_seen} now={now} /> · first <Ago at={i.first_seen} now={now} />
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
              </Link>
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
