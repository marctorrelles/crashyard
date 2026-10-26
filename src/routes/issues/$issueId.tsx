import { createFileRoute, Link, notFound, useNavigate, useRouter } from '@tanstack/react-router'
import { IconChevronLeft, IconChevronRight, IconTrash } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Ago, count, Level, LocalTime } from '@/components/bits'
import { BarList, LEVEL_COLORS, TimeChart } from '@/components/charts'
import { EventView } from '@/components/event-view'
import { IssueActions } from '@/components/issue-actions'
import { Shell } from '@/components/shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { addNote, deleteNote, getIssue } from '@/fns'
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
            {issue.culprit && <span className="font-mono text-xs break-all">{issue.culprit}</span>}
            <StatusBadge issue={issue} now={now} />
          </p>
        </div>
        <IssueActions ids={[issue.id]} status={issue.status} />
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
                    <Link
                      to="/logs"
                      search={{ query: `trace:${event.traceId}`, range: '30d' }}
                      className="ml-2 text-xs underline"
                    >
                      Logs in this trace
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
        {issue.resolved_in_release ? `Resolved after ${issue.resolved_in_release}` : 'Resolved'}
      </Badge>
    )
  if (issue.status === 'ignored') {
    return (
      <Badge variant="outline">
        Ignored
        {issue.ignore_until_count ? ` until ${count(issue.ignore_until_count)} events` : null}
        {!issue.ignore_until_count && issue.ignore_until ? (
          <>
            {' until '}
            <LocalTime at={issue.ignore_until} />
          </>
        ) : null}
      </Badge>
    )
  }
  if (issue.substatus === 'regressed') return <Badge variant="destructive">Regressed</Badge>
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

function Events({ d, current }: { d: Data; current?: string }) {
  if (d.events.length < 2) return null
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-sm font-medium">
        Events <span className="font-normal text-muted-foreground">(latest {d.events.length})</span>
      </h2>
      <ul className="max-h-96 divide-y overflow-auto rounded-xl border text-sm">
        {d.events.map((e) => (
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
  resolved: (x) => (x.inRelease ? 'Resolved in the next release' : 'Resolved'),
  ignored: (x) =>
    x.forEvents ? (
      `Ignored for ${x.forEvents} more events`
    ) : x.until ? (
      <>
        Ignored until <LocalTime at={x.until as number} />
      </>
    ) : (
      'Ignored'
    ),
  reopened: () => 'Reopened',
  merged: (x) => `Merged with ${(x.issues as { title: string }[]).map((i) => `“${i.title}”`).join(', ')}`,
  review_crash: () => 'Crashed in App Review or TestFlight',
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
