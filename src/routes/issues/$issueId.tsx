import { createFileRoute, Link, notFound, useNavigate, useRouter } from '@tanstack/react-router'
import { IconChevronLeft, IconChevronRight, IconGitCommit, IconGitMerge, IconTrash } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Ago, count, Level } from '@/components/bits'
import { Time } from '@/components/time'
import { BarList, LEVEL_COLORS, TimeChart } from '@/components/charts'
import { EventView } from '@/components/event-view'
import { IssueActions, UnmergeButton } from '@/components/issue-actions'
import { AssignMenu, BookmarkButton, TrackerMenu } from '@/components/issue-triage'
import { PRIORITY_LABELS, PriorityBadge } from '@/components/priority'
import { Shell } from '@/components/shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { SearchBar } from '@/components/search-bar'
import { addNote, deleteNote, getIssue, getIssueEvents, mergeIssues } from '@/fns'
import type { NormalizedEvent } from '@/ingest/event'
import { addValue, isSearchableKey, NEW_FOR } from '@/search/query'

export const Route = createFileRoute('/issues/$issueId')({
  validateSearch: (s: Record<string, unknown>): { event?: string } => ({
    event: typeof s.event === 'string' && /^[0-9a-f]{32}$/.test(s.event) ? s.event : undefined,
  }),
  loaderDeps: ({ search }) => ({ event: search.event }),
  loader: async ({ params, deps }) => {
    const issue = await getIssue({ data: { id: Number(params.issueId), event: deps.event } })
    if (!issue) throw notFound()
    return issue
  },
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.issue.title ?? 'Issue'} · crashyard` }] }),
  notFoundComponent: () => (
    <Shell crumbs={[<Link to="/issues">Issues</Link>, 'Not found']}>
      <p className="text-muted-foreground">
        This issue doesn’t exist. It may have been deleted, or merged into another issue.
      </p>
    </Shell>
  ),
  component: IssuePage,
})

function IssuePage() {
  const d = Route.useLoaderData()
  const { issue, now } = d
  const event = useMemo(() => (d.eventJson ? (JSON.parse(d.eventJson) as NormalizedEvent) : null), [d.eventJson])
  const current = d.events.find((e) => e.id === event?.id)
  return (
    <Shell
      wide
      crumbs={[
        <Link to="/issues">Issues</Link>,
        <Link to="/issues" search={{ project: issue.project }}>
          {issue.project_name}
        </Link>,
        issue.title,
      ]}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight break-words">
            <span className="mr-2 inline-block -translate-y-0.5 align-middle">
              <Level level={issue.level} />
            </span>
            {issue.title}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <PriorityBadge id={issue.id} priority={issue.priority} />
            <StatusBadge issue={issue} now={now} />
            {issue.culprit && <span className="font-mono text-xs break-all">{issue.culprit}</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {d.merged > 0 && <UnmergeButton id={issue.id} now={now} />}
          <IssueActions ids={[issue.id]} status={issue.status} lastRelease={issue.last_release} releases={d.releases} />
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <BookmarkButton id={issue.id} on={d.bookmarked} />
        <AssignMenu issue={issue} people={d.assignees} viewer={d.viewer} />
        <TrackerMenu issue={issue} event={event} repo={d.repoUrl} url={`${d.origin}/issues/${issue.id}`} />
      </div>

      <dl className="mb-6 grid grid-cols-2 gap-3 rounded-xl border p-4 text-sm sm:grid-cols-4">
        <Stat label="Events" value={count(issue.count)} />
        <Stat label="Users" value={count(issue.user_count)} />
        <Stat label="First seen" value={<Ago at={issue.first_seen} now={now} />} sub={issue.first_release} />
        <Stat label="Last seen" value={<Ago at={issue.last_seen} now={now} />} sub={issue.last_release} />
        <div className="col-span-full">
          <TimeChart
            x={d.days}
            series={[{ key: 'events', label: 'Events', values: d.series, color: LEVEL_COLORS[issue.level] }]}
            height={120}
          />
        </div>
      </dl>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0">
          {event ? (
            <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/50 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <span className="font-mono text-xs">{event.id.slice(0, 12)}</span>
                  <span className="text-muted-foreground">
                    {' · '}
                    {current ? <Ago at={current.received} now={now} /> : null}
                    {event.release && ` · ${event.release}`}
                    {event.environment && ` · ${event.environment}`}
                  </span>
                  {event.traceId && (
                    <Link to="/traces/$traceId" params={{ traceId: event.traceId }} className="ml-2 text-xs underline">
                      Open trace
                    </Link>
                  )}
                </div>
                <div className="flex gap-1">
                  <EventLink id={issue.id} event={d.older} label="Older event">
                    <IconChevronLeft />
                  </EventLink>
                  <EventLink id={issue.id} event={d.newer} label="Newer event">
                    <IconChevronRight />
                  </EventLink>
                </div>
              </div>
              <EventView event={event} links={d.links} attachments={d.attachments} />
              <Suspects d={d} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              This issue’s events are older than the project keeps. Its counts and history remain.
            </p>
          )}
          {d.feedback.length > 0 && (
            <section className="mt-8">
              <h2 className="mb-2 text-sm font-medium">User feedback</h2>
              <ul className="grid gap-2">
                {d.feedback.map((f) => (
                  <li key={f.id} className="rounded-xl border p-3 text-sm">
                    <p className="whitespace-pre-wrap">{f.message}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {f.name ?? 'Anonymous'} · <Ago at={f.at} now={now} />
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Similar d={d} />
          <Events d={d} current={event?.id} />
        </div>
        <aside className="grid content-start gap-6">
          <Tags tags={d.tags} project={issue.project} />
          <Activity d={d} />
        </aside>
      </div>
    </Shell>
  )
}

type Data = NonNullable<Awaited<ReturnType<typeof getIssue>>>

function StatusBadge({ issue, now }: { issue: Data['issue']; now: number }) {
  if (issue.status === 'resolved')
    return (
      <Badge variant="outline">
        {issue.fixed_in_release
          ? `Resolved in ${issue.fixed_in_release}`
          : issue.resolved_in_release
            ? `Resolved after ${issue.resolved_in_release}`
            : 'Resolved'}
      </Badge>
    )
  if (issue.status === 'ignored') {
    return (
      <Badge variant="outline">
        Ignored
        {issue.substatus === 'until_escalating' ? ' until it escalates' : null}
        {issue.ignore_until_count ? ` until ${count(issue.ignore_until_count)} events` : null}
        {issue.ignore_until_users ? ` until ${count(issue.ignore_until_users)} users` : null}
        {!issue.ignore_until_count && issue.ignore_until ? (
          <>
            {' until '}
            <Time at={issue.ignore_until} />
          </>
        ) : null}
      </Badge>
    )
  }
  if (issue.substatus === 'regressed') return <Badge variant="destructive">Regressed</Badge>
  if (issue.substatus === 'escalating') return <Badge variant="destructive">Escalating</Badge>
  if (issue.substatus === 'new' && issue.first_seen > now - NEW_FOR) return <Badge variant="secondary">New</Badge>
  return null
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
      {sub && <dd className="truncate font-mono text-xs text-muted-foreground">{sub}</dd>}
    </div>
  )
}

function EventLink({
  id,
  event,
  label,
  children,
}: {
  id: number
  event?: string
  label: string
  children: React.ReactNode
}) {
  if (!event)
    return (
      <Button variant="ghost" size="icon-sm" disabled aria-label={label}>
        {children}
      </Button>
    )
  return (
    <Button variant="ghost" size="icon-sm" asChild>
      <Link
        to="/issues/$issueId"
        params={{ issueId: String(id) }}
        search={{ event }}
        aria-label={label}
        resetScroll={false}
      >
        {children}
      </Link>
    </Button>
  )
}

// Each tag's top values with their share of the issue's events; + and − list the unresolved issues of its project
// with or without that value
function Tags({ tags, project }: { tags: Data['tags']; project: string }) {
  const navigate = useNavigate()
  const byKey = Map.groupBy(tags, (t) => t.key)
  if (!byKey.size) return null
  const search = (key: string, value: string, negate: boolean) =>
    void navigate({ to: '/issues', search: { query: addValue('is:unresolved', key, value, negate), project } })
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium">Tags</h2>
      <div className="grid gap-4">
        {[...byKey].map(([key, values]) => (
          <div key={key}>
            <h3 className="mb-1 text-xs text-muted-foreground">{key}</h3>
            <BarList
              items={values}
              total={values[0].total}
              onInclude={isSearchableKey(key) ? (v) => search(key, v, false) : undefined}
              onExclude={isSearchableKey(key) ? (v) => search(key, v, true) : undefined}
            />
          </div>
        ))}
      </div>
    </section>
  )
}

// The first release's commits that changed a file of the top in-app frames
function Suspects({ d }: { d: Data }) {
  if (!d.suspects.length) return null
  return (
    <section className="mt-8">
      <h2 className="mb-1 text-sm font-medium">Suspect commits</h2>
      <p className="mb-2 text-xs text-muted-foreground">
        Commits in {d.issue.first_release} that changed a file in this stack.
      </p>
      <ul className="divide-y rounded-xl border text-sm">
        {d.suspects.map((c) => (
          <li key={c.sha} className="flex items-start gap-3 px-3 py-2">
            <IconGitCommit className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate">{c.message.split('\n')[0] || 'No message'}</p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noreferrer" className="font-mono underline">
                    {c.sha.slice(0, 7)}
                  </a>
                ) : (
                  <span className="font-mono">{c.sha.slice(0, 7)}</span>
                )}
                {c.author && ` · ${c.author}`}
                {c.at ? (
                  <>
                    {' · '}
                    <Ago at={c.at} now={d.now} />
                  </>
                ) : null}
                {` · ${c.files.map((f) => f.split('/').at(-1)).join(', ')}`}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

// Issues that look like this one under another fingerprint, each with a merge into this one
function Similar({ d }: { d: Data }) {
  const router = useRouter()
  if (!d.similar.length) return null
  const merge = async (other: Data['similar'][number]) => {
    if (!confirm(`Merge “${other.title}” into this issue? Its events, and any future ones, move here.`)) return
    try {
      await mergeIssues({ data: { ids: [d.issue.id, other.id] } })
      toast.success('Merged into this issue')
      await router.invalidate()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The issues couldn’t be merged')
    }
  }
  return (
    <section className="mt-8">
      <h2 className="mb-1 text-sm font-medium">Similar issues</h2>
      <p className="mb-2 text-xs text-muted-foreground">The same error in the same function, grouped apart.</p>
      <ul className="divide-y rounded-xl border text-sm">
        {d.similar.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <Link
              to="/issues/$issueId"
              params={{ issueId: String(i.id) }}
              className="min-w-0 flex-1 basis-full hover:underline sm:basis-0"
            >
              <span className="block truncate">{i.title}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {count(i.count)} events · <Ago at={i.last_seen} now={d.now} />
                {i.status !== 'unresolved' && ` · ${i.status}`}
              </span>
            </Link>
            <Button size="sm" variant="outline" className="max-sm:h-9" onClick={() => merge(i)}>
              <IconGitMerge data-icon="inline-start" />
              Merge into this issue
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Events({ d, current }: { d: Data; current?: string }) {
  // A search over this issue's events, Explore's (`getIssueEvents`); none shows the latest as loaded
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<{ id: string; received: number; release?: string; environment?: string }[] | null>(
    null,
  )
  if (d.events.length < 2 && found === null) return null
  const search = async (q: string) => {
    setQuery(q)
    if (!q.trim()) return setFound(null)
    try {
      const r = await getIssueEvents({ data: { issue: d.issue.id, query: q, columns: ['release', 'environment'] } })
      setFound(
        r.rows.map((e) => ({
          id: e.id,
          received: e.received,
          release: e.values[0] ?? undefined,
          environment: e.values[1] ?? undefined,
        })),
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That search didn’t work. Check it and try again.')
    }
  }
  const list = found ?? d.events
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-sm font-medium">
        Events{' '}
        <span className="font-normal text-muted-foreground">
          {found === null
            ? `(latest ${d.events.length})`
            : `(${found.length === 50 ? 'newest 50' : found.length} matching)`}
        </span>
      </h2>
      <div className="mb-2">
        <SearchBar
          scope="events"
          query={query}
          project={d.issue.project}
          placeholder="device:iPad* release:1.2"
          onSearch={(q) => void search(q)}
        />
      </div>
      {list.length === 0 && <p className="text-sm text-muted-foreground">No events of this issue match.</p>}
      <ul className="max-h-96 divide-y overflow-auto rounded-xl border text-sm empty:hidden">
        {list.map((e) => (
          <li key={e.id}>
            <Link
              to="/issues/$issueId"
              params={{ issueId: String(d.issue.id) }}
              search={{ event: e.id }}
              resetScroll={false}
              className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40 aria-[current=true]:bg-muted"
              aria-current={e.id === current}
            >
              <span className="font-mono text-xs">{e.id.slice(0, 8)}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {[e.release, e.environment].filter(Boolean).join(' · ')}
              </span>
              <Ago at={e.received} now={d.now} className="text-xs text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

const KIND_TEXT: Record<string, (data: Record<string, unknown>) => React.ReactNode> = {
  created: (x) => `First seen${x.release ? ` in ${x.release}` : ''}`,
  regressed: (x) => `Regressed${x.release ? ` in ${x.release}` : ''}`,
  ignore_expired: () => 'Ignore period ended',
  resolved: (x) =>
    x.commit
      ? `Resolved in ${String(x.release)} by commit ${String((x.commit as { sha: string }).sha).slice(0, 7)}: ${String((x.commit as { message: string }).message).split('\n')[0]}`
      : x.release
        ? `Resolved in ${String(x.release)}`
        : x.inRelease
          ? 'Resolved in the next release'
          : 'Resolved',
  auto_resolved: (x) => `Resolved after ${x.days} day${x.days === 1 ? '' : 's'} without events`,
  ignored: (x) =>
    x.untilEscalating ? (
      'Ignored until it escalates'
    ) : x.forEvents ? (
      `Ignored for ${x.forEvents} more events`
    ) : x.forUsers ? (
      `Ignored until ${x.forUsers} more users`
    ) : x.until ? (
      <>
        Ignored until <Time at={x.until as number} />
      </>
    ) : (
      'Ignored'
    ),
  reopened: () => 'Reopened',
  unmerged: (x) =>
    x.issue
      ? `Unmerged “${(x.issue as { title: string }).title}” into its own issue`
      : 'Unmerged a fingerprint with no events kept',
  unmerged_from: (x) => `Unmerged from issue ${(x.issue as { id: number }).id}`,
  merged: (x) => `Merged with ${(x.issues as { title: string }[]).map((i) => `“${i.title}”`).join(', ')}`,
  review_crash: () => 'Crashed in App Review or TestFlight',
  escalating: (x) => `Escalating with ${x.count} events in an hour${x.wasIgnored ? ', so it’s no longer ignored' : ''}`,
  assigned: (x) => (x.assignee ? `Assigned to ${String(x.assignee)}` : 'Unassigned'),
  linked: (x) => (x.url ? `Linked ${String(x.url)}` : 'Unlinked its tracker issue'),
  priority: (x) =>
    `Priority set to ${PRIORITY_LABELS[x.priority as keyof typeof PRIORITY_LABELS]?.toLowerCase() ?? x.priority}`,
}

function Activity({ d }: { d: Data }) {
  const router = useRouter()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium">Activity</h2>
      <form
        className="mb-4 grid gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!note.trim()) return
          setBusy(true)
          try {
            await addNote({ data: { id: d.issue.id, text: note } })
            setNote('')
            await router.invalidate()
          } catch {
            toast.error('The note wasn’t saved')
          } finally {
            setBusy(false)
          }
        }}
      >
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note"
          rows={2}
          aria-label="Note"
        />
        {note.trim() && (
          <Button type="submit" size="sm" className="justify-self-end" disabled={busy}>
            Add note
          </Button>
        )}
      </form>
      <ol className="grid gap-3 border-l pl-4">
        {d.activity.map((a) => {
          const data = a.data ? (JSON.parse(a.data) as Record<string, unknown>) : {}
          return (
            <li key={a.id} className="relative text-sm">
              <span className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full border-2 border-background bg-muted-foreground/50" />
              {a.kind === 'note' ? (
                <div className="rounded-lg bg-muted/60 p-2.5">
                  <p className="break-words whitespace-pre-wrap">{String(data.text)}</p>
                </div>
              ) : (
                <p>{KIND_TEXT[a.kind]?.(data) ?? a.kind}</p>
              )}
              <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                {a.by ?? 'crashyard'} · <Ago at={a.at} now={d.now} />
                {a.kind === 'note' && a.by === d.viewer && (
                  <button
                    type="button"
                    className="ml-auto hover:text-foreground"
                    aria-label="Delete note"
                    onClick={async () => {
                      await deleteNote({ data: { id: d.issue.id, note: a.id } })
                      await router.invalidate()
                    }}
                  >
                    <IconTrash className="size-3.5" />
                  </button>
                )}
              </p>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
