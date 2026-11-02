import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router'
import { IconAlertTriangle, IconArrowLeft, IconSearch, IconUserQuestion, IconUsers } from '@tabler/icons-react'
import { useState } from 'react'
import {
  AnalyticsTabs,
  countryName,
  FilterBar,
  type FilterSearch,
  PeriodSelect,
  readDays,
  readFilter,
  toFilter,
} from '@/components/analytics'
import { Ago, count, Level } from '@/components/bits'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { formatTime, Time, useTimePrefs } from '@/components/time'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getUsers } from '@/fns'
import { cn } from '@/lib/utils'

type Search = FilterSearch & { project?: string; days?: number; user?: string; hash?: string }

export const Route = createFileRoute('/analytics/users')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
    days: readDays(s.days),
    user: typeof s.user === 'string' && s.user ? s.user : undefined,
    hash: typeof s.hash === 'string' && /^[0-9a-f]{32}$/.test(s.hash) ? s.hash : undefined,
    ...readFilter(s),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const data = await getUsers({
      data: { slug: deps.project, days: deps.days ?? 30, filter: toFilter(deps), user: deps.user, hash: deps.hash },
    })
    if (!data) throw notFound()
    return data
  },
  head: () => ({ meta: [{ title: 'Users · Analytics · crashyard' }] }),
  component: Users,
})

type Data = NonNullable<Awaited<ReturnType<typeof getUsers>>>

/** A user as they're kept: the start of their hash, as the id itself isn't */
const short = (hash: string) => hash.slice(0, 8)

function Users() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const p = data.project
  const open = !!(search.user || search.hash)
  return (
    <Shell crumbs={p ? [<Link to="/analytics/users">Analytics</Link>, p.name] : ['Analytics']}>
      <PageHeader
        title="Users"
        actions={
          !open && (
            <PeriodSelect
              days={search.days ?? 30}
              onChange={(v) => void navigate({ search: (s) => ({ ...s, days: v === 30 ? undefined : v }) })}
            />
          )
        }
      >
        {p?.name}
      </PageHeader>
      <AnalyticsTabs at="/analytics/users" search={search} />
      <Find
        initial={search.user ?? ''}
        onFind={(user) => void navigate({ search: (s) => ({ ...s, user, hash: undefined }) })}
      />
      {open ? (
        <Timeline
          data={data}
          typed={search.user}
          onBack={() => void navigate({ search: (s) => ({ ...s, user: undefined, hash: undefined }) })}
        />
      ) : (
        <>
          <FilterBar
            options={data.options}
            search={search}
            onChange={(f) => void navigate({ search: (s) => ({ ...s, ...f }) })}
          />
          <List data={data} />
        </>
      )}
    </Shell>
  )
}

/** Find a user by the id the app sets, hashed on the server as ingest hashes it */
function Find({ initial, onFind }: { initial: string; onFind: (user: string | undefined) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <form
      className="mb-4 flex max-w-lg gap-2"
      role="search"
      onSubmit={(e) => {
        e.preventDefault()
        onFind(value.trim() || undefined)
      }}
    >
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="A user id, as your app sets it"
        aria-label="User id"
        className="h-10"
        maxLength={200}
      />
      <Button type="submit" variant="outline" className="h-10">
        <IconSearch />
        Find user
      </Button>
    </form>
  )
}

function List({ data }: { data: Data }) {
  const users = data.users
  if (!users || users.list.length === 0)
    return (
      <Empty icon={IconUsers} title="No users in this period">
        Users appear once actions name them. Set the user with <code>Sentry.setUser</code>.
      </Empty>
    )
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground">
        {count(users.total)} users in this period, the 50 seen most recently first. Users are kept only as a hash, so
        each shows as the start of it.
      </p>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm tabular-nums">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b">
              <th className="px-4 py-2 text-left font-medium">User</th>
              <th className="px-3 py-2 text-left font-medium">Last seen</th>
              <th className="px-3 py-2 text-left font-medium max-md:hidden">First seen</th>
              <th className="px-3 py-2 text-right font-medium">Actions</th>
              <th className="px-3 py-2 text-right font-medium">Errors</th>
              <th className="px-3 py-2 text-left font-medium max-lg:hidden">Platform</th>
              <th className="px-3 py-2 text-left font-medium max-md:hidden">Country</th>
              <th className="px-4 py-2 text-left font-medium max-lg:hidden">Release</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {users.list.map((u) => (
              <tr key={u.user} className="hover:bg-muted/40">
                <td className="px-4 py-2.5">
                  <Link
                    from={Route.fullPath}
                    search={(s) => ({ ...s, hash: u.user, user: undefined })}
                    className="font-mono text-xs font-medium hover:underline"
                  >
                    {short(u.user)}
                  </Link>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">
                  <Ago at={u.last} now={data.now} />
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground max-md:hidden">
                  <Ago at={u.first} now={data.now} />
                </td>
                <td className="px-3 py-2.5 text-right">{count(u.actions)}</td>
                <td
                  className={cn(
                    'px-3 py-2.5 text-right',
                    u.errors > 0 ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-muted-foreground',
                  )}
                >
                  {u.errors > 0 ? count(u.errors) : '–'}
                </td>
                <td className="px-3 py-2.5 text-muted-foreground max-lg:hidden">
                  {[u.platform, u.os, u.device].filter(Boolean).join(' · ') || '–'}
                </td>
                <td className="px-3 py-2.5 text-muted-foreground max-md:hidden">
                  {u.country ? countryName(u.country) : '–'}
                </td>
                <td className="max-w-40 truncate px-4 py-2.5 font-mono text-xs text-muted-foreground max-lg:hidden">
                  {u.release ?? '–'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/** One user: what's known of them, then their actions and errors by day, newest first */
function Timeline({ data, typed, onBack }: { data: Data; typed?: string; onBack: () => void }) {
  const prefs = useTimePrefs()
  const t = data.timeline
  const back = (
    <Button variant="ghost" className="mb-3 h-10 px-2" onClick={onBack}>
      <IconArrowLeft />
      All users
    </Button>
  )
  if (!t || (t.actions === 0 && t.timeline.length === 0))
    return (
      <>
        {back}
        <Empty icon={IconUserQuestion} title="No one by that id">
          {typed ? (
            <>
              No action or error names <code>{typed}</code>. Ids match exactly, as your app set them.
            </>
          ) : (
            'This user has no actions or errors kept.'
          )}
        </Empty>
      </>
    )
  const days = Map.groupBy(t.timeline, (x) => formatTime(x.at, prefs, 'key'))
  const facts = [
    ['First seen', t.first ? <Time at={t.first} style="day" /> : '–'],
    ['Last seen', t.last ? <Ago at={t.last} now={data.now} /> : '–'],
    ['Actions', count(t.actions)],
    ['Errors', count(t.errors)],
    ['Platform', [t.platform, t.os, t.device].filter(Boolean).join(' · ') || '–'],
    ['Country', t.country ? countryName(t.country) : '–'],
    ['Release', t.release ?? '–'],
  ] as const
  return (
    <>
      {back}
      <section className="mb-6 rounded-xl border p-4">
        <h2 className="mb-3 text-sm font-medium">
          {typed ? <span className="font-mono">{typed}</span> : 'User'}{' '}
          <span className="font-mono text-xs font-normal text-muted-foreground">{short(data.hash ?? '')}</span>
        </h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          {facts.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="truncate">{value}</dd>
            </div>
          ))}
        </dl>
        {Object.keys(t.properties).length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {Object.entries(t.properties).map(([k, v]) => (
              <span key={k} className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
                <span className="text-muted-foreground">{k}</span> {String(v)}
              </span>
            ))}
          </div>
        )}
      </section>
      <ol className="grid grid-cols-1 gap-6">
        {[...days].map(([day, items]) => (
          <li key={day}>
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">
              {formatTime(items[0].at, prefs, 'weekday')}
            </h3>
            <ol className="divide-y rounded-xl border">
              {items.map((x, i) => (
                <li key={i} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                  <span className="w-14 shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
                    {formatTime(x.at, prefs, 'time')}
                  </span>
                  {x.kind === 'error' ? (
                    <div className="min-w-0 flex-1">
                      <p className="flex min-w-0 items-center gap-2 text-amber-700 dark:text-amber-400">
                        <IconAlertTriangle className="size-4 shrink-0" />
                        <Link
                          to="/issues/$issueId"
                          params={{ issueId: String(x.issue) }}
                          search={{ event: x.event }}
                          className="truncate font-medium hover:underline"
                        >
                          {x.title}
                        </Link>
                        <Level level={x.level} />
                      </p>
                      {x.release && <p className="text-xs text-muted-foreground">{x.release}</p>}
                    </div>
                  ) : (
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs font-medium">{x.name}</p>
                      {Object.keys(x.properties).length > 0 && (
                        <p className="truncate text-xs text-muted-foreground">
                          {Object.entries(x.properties)
                            .map(([k, v]) => `${k} ${String(v)}`)
                            .join(' · ')}
                        </p>
                      )}
                    </div>
                  )}
                  {x.trace && (
                    <Link
                      to="/traces/$traceId"
                      params={{ traceId: x.trace }}
                      className="shrink-0 text-xs text-muted-foreground hover:text-foreground hover:underline max-sm:hidden"
                    >
                      Trace
                    </Link>
                  )}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </>
  )
}
