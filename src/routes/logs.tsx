import { createFileRoute, Link, useHydrated, useNavigate } from '@tanstack/react-router'
import { ChevronRightIcon, PauseIcon, PlayIcon, SearchIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Empty, PageHeader, Shell, useProjects } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getLogs } from '@/fns'
import { cn } from '@/lib/utils'
import { withToken } from '@/search/query'

const RANGES = { '1h': 'Last hour', '24h': 'Last day', '7d': 'Last week', '30d': 'Last 30 days' } as const
type Search = { project?: string; query?: string; range?: keyof typeof RANGES }

export const Route = createFileRoute('/logs')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
    query: typeof s.query === 'string' && s.query ? s.query : undefined,
    range: typeof s.range === 'string' && s.range in RANGES ? (s.range as Search['range']) : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) =>
    getLogs({ data: { project: deps.project, query: deps.query ?? '', range: deps.range ?? '24h' } }),
  head: () => ({ meta: [{ title: 'Logs · crashyard' }] }),
  component: Logs,
})

type Log = Awaited<ReturnType<typeof getLogs>>['logs'][number]

const LEVEL_STYLE: Record<string, string> = {
  fatal: 'bg-red-600 text-white',
  error: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  warn: 'bg-amber-400/20 text-amber-800 dark:text-amber-300',
  info: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  debug: 'bg-muted text-muted-foreground',
  trace: 'bg-muted text-muted-foreground',
}

function Logs() {
  const search = Route.useSearch()
  const data = Route.useLoaderData()
  const navigate = useNavigate({ from: Route.fullPath })
  const query = search.query ?? ''
  const go = (change: Partial<Search>) => void navigate({ search: (s) => ({ ...s, ...change }) })
  const [live, setLive] = useState(false)
  const params = { project: search.project, query, range: search.range ?? '24h' }
  // Keys whose values all differ (an id, a duration) say nothing as a facet
  const facets = new Map(
    [...Map.groupBy(data.facets, (f) => f.key)].filter(([, values]) => values[0].n > 1).slice(0, 10),
  )
  return (
    <Shell wide>
      <PageHeader title="Logs">{useProjects().find((p) => p.slug === search.project)?.name}</PageHeader>
      <div className="mb-3 flex flex-wrap gap-2">
        <form
          key={query}
          className="min-w-60 flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            go({ query: String(new FormData(e.currentTarget).get('q')) || undefined })
          }}
        >
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              name="q"
              defaultValue={query}
              placeholder='level:error song:42 "export failed"'
              aria-label="Search logs"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
            />
          </InputGroup>
        </form>
        <Select
          value={search.range ?? '24h'}
          onValueChange={(v) => go({ range: v === '24h' ? undefined : (v as Search['range']) })}
        >
          <SelectTrigger className="w-36" aria-label="Time range">
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
        <Button variant={live ? 'default' : 'outline'} onClick={() => setLive(!live)} aria-pressed={live}>
          {live ? <PauseIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
          Live
        </Button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[14rem_minmax(0,1fr)]">
        {facets.size > 0 && (
          <>
            <aside className="max-lg:hidden">
              <Facets facets={facets} onPick={(key, value) => go({ query: withToken(query, key, value) })} />
            </aside>
            <details className="rounded-xl border lg:hidden">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Filters</summary>
              <div className="p-3 pt-0">
                <Facets facets={facets} onPick={(key, value) => go({ query: withToken(query, key, value) })} />
              </div>
            </details>
          </>
        )}
        <div className="min-w-0 lg:col-start-2">
          <LogStream
            key={JSON.stringify(params)}
            initial={data}
            params={params}
            live={live}
            showProject={!search.project}
          />
        </div>
      </div>
    </Shell>
  )
}

function Facets({
  facets,
  onPick,
}: {
  facets: Map<string, { key: string; value: string; n: number }[]>
  onPick: (key: string, value: string) => void
}) {
  return (
    <div className="grid gap-4">
      {[...facets].map(([key, values]) => (
        <div key={key}>
          <h3 className="mb-1 text-xs text-muted-foreground">{key}</h3>
          <ul className="grid gap-0.5">
            {values.map((v) => (
              <li key={v.value}>
                <button
                  type="button"
                  className="flex w-full justify-between gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-muted"
                  onClick={() => onPick(key, v.value)}
                >
                  <span className="truncate font-mono">{v.value}</span>
                  <span className="text-muted-foreground tabular-nums">{v.n}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

type Params = { project?: string; query: string; range: keyof typeof RANGES }

/** The loader's page, plus what the live tail and "Older" add; a new search mounts a new one */
function LogStream({
  initial,
  params,
  live,
  showProject,
}: {
  initial: { logs: Log[]; more: boolean }
  params: Params
  live: boolean
  showProject: boolean
}) {
  const [logs, setLogs] = useState(initial.logs)
  const [more, setMore] = useState(initial.more)
  const newest = useRef(logs[0])
  useEffect(() => {
    newest.current = logs[0]
  }, [logs])
  useEffect(() => {
    if (!live) return
    const timer = setInterval(async () => {
      const head = newest.current
      const fresh = await getLogs({
        data: { ...params, after: head ? { timestamp: head.timestamp, id: head.id } : undefined },
      })
      if (fresh.logs.length) setLogs((l) => [...fresh.logs, ...l].slice(0, 1000))
    }, 2000)
    return () => clearInterval(timer)
  }, [live, params])
  return (
    <>
      {logs.length === 0 ? (
        <Empty title="No logs">
          {params.query ? 'Nothing matches in this time range.' : 'Logs sent with Sentry.logger show up here.'}
        </Empty>
      ) : (
        <ol className="divide-y overflow-hidden rounded-xl border font-mono text-xs">
          {logs.map((l) => (
            <LogLine key={l.id} log={l} showProject={showProject} />
          ))}
        </ol>
      )}
      {more && !live && (
        <div className="mt-3 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const last = logs.at(-1)!
              const older = await getLogs({ data: { ...params, before: { timestamp: last.timestamp, id: last.id } } })
              setLogs((l) => [...l, ...older.logs])
              setMore(older.more)
            }}
          >
            Older
          </Button>
        </div>
      )}
    </>
  )
}

function Clock({ at }: { at: number }) {
  // The browser's time once it's here; the server renders UTC
  const hydrated = useHydrated()
  const d = new Date(at)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const text = hydrated
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
    : `${d.toISOString().slice(11, 23)}Z`
  return (
    <time
      dateTime={d.toISOString()}
      title={hydrated ? d.toLocaleString() : d.toUTCString()}
      className="text-muted-foreground tabular-nums"
    >
      {text}
    </time>
  )
}

function LogLine({ log: l, showProject }: { log: Log; showProject: boolean }) {
  const attributes = Object.entries(JSON.parse(l.attributes) as Record<string, unknown>)
  const own = attributes.filter(([k]) => !k.startsWith('sentry.'))
  return (
    <li>
      <details className="group">
        <summary className="flex cursor-pointer items-start gap-2 px-3 py-1.5 hover:bg-muted/40">
          <ChevronRightIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          <Clock at={l.timestamp} />
          <span
            className={cn(
              'w-11 shrink-0 rounded px-1 text-center text-[0.65rem] leading-4 uppercase',
              LEVEL_STYLE[l.level],
            )}
          >
            {l.level}
          </span>
          <span className="min-w-0 flex-1 break-words group-open:whitespace-pre-wrap">
            {showProject && <span className="mr-2 text-muted-foreground">{l.project}</span>}
            {l.body}
            {own.length > 0 && (
              <span className="ml-2 text-muted-foreground max-sm:hidden">
                {own
                  .slice(0, 4)
                  .map(([k, v]) => `${k}=${String(v)}`)
                  .join(' ')}
              </span>
            )}
          </span>
        </summary>
        <div className="grid gap-2 border-t bg-muted/30 px-3 py-3 pl-8">
          <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-0.5">
            {[['release', l.release], ['environment', l.environment], ...attributes]
              .filter(([, v]) => v !== null && v !== undefined)
              .map(([k, v]) => (
                <div key={String(k)} className="contents">
                  <dt className="text-muted-foreground">{String(k)}</dt>
                  <dd className="break-all">{String(v)}</dd>
                </div>
              ))}
          </dl>
          {l.trace_id && (
            <p className="flex flex-wrap gap-3 font-sans">
              <Link to="/logs" search={{ query: `trace:${l.trace_id}`, range: '30d' }} className="underline">
                Logs of this trace
              </Link>
              <Link to="/issues" search={{ query: `trace:${l.trace_id}` }} className="underline">
                Its issues
              </Link>
            </p>
          )}
        </div>
      </details>
    </li>
  )
}
