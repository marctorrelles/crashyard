// One event, as Sentry shows it: the exception with its stack (where it happened first, other code folded),
// breadcrumbs, tags, contexts and the raw JSON.
import { IconChevronRight, IconExternalLink } from '@tabler/icons-react'
import { useState } from 'react'
import { type Attachment, Attachments } from '@/components/attachments'
import { usePreferences } from '@/components/shell'
import { Time } from '@/components/time'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import type { Breadcrumb, ExceptionValue, Frame, NormalizedEvent, RequestInfo, Thread } from '@/ingest/event'
import { cn } from '@/lib/utils'

/** `links`: a frame's line in the repository, by `exception.frame` (their indexes in the event, `frameLinks`) */
export function EventView({
  event,
  links = {},
  attachments = [],
}: {
  event: NormalizedEvent
  links?: Record<string, string>
  attachments?: Attachment[]
}) {
  // The thrown exception first (Sentry sends the chain oldest first)
  const exceptions = event.exceptions.map((e, i) => ({ e, i })).reverse()
  return (
    // grid-cols-1, a minmax(0, 1fr) column: a long stack or header line scrolls inside it, never widens it (Safari did)
    <div className="grid grid-cols-1 gap-6">
      {event.missingDebugFiles?.length ? (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="font-medium">Some frames show only memory addresses because their debug files are missing.</p>
          <ul className="mt-1 grid gap-0.5 text-xs">
            {event.missingDebugFiles.map((m) => (
              <li key={m.debugId} className="font-mono break-all">
                {m.type === 'proguard' ? 'ProGuard mapping' : (m.codeFile?.split('/').at(-1) ?? m.type)} · {m.debugId}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted-foreground">
            Upload the files below from the project’s settings. This event is then processed again automatically.
          </p>
        </div>
      ) : null}
      {exceptions.length > 0 ? (
        exceptions.map(({ e, i }) => <Exception key={i} exception={e} link={(j) => links[`${i}.${j}`]} />)
      ) : (
        <Section title="Message">
          <pre className="text-sm whitespace-pre-wrap">{event.message || event.title}</pre>
        </Section>
      )}
      <Threads event={event} />
      {attachments.length > 0 && <Attachments attachments={attachments} />}
      {event.breadcrumbs.length > 0 && <Breadcrumbs crumbs={event.breadcrumbs} />}
      {event.request && <Request request={event.request} />}
      {Object.keys(event.tags).length > 0 && (
        <Section title="Tags">
          <dl className="flex flex-wrap gap-1.5">
            {Object.entries(event.tags).map(([k, v]) => (
              <div key={k} className="flex overflow-hidden rounded-md border text-xs">
                <dt className="bg-muted px-1.5 py-0.5 text-muted-foreground">{k}</dt>
                <dd className="px-1.5 py-0.5 font-mono break-all">{v}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}
      {Object.keys(event.contexts).length > 0 && <Contexts contexts={event.contexts} />}
      {event.extra && (
        <Section title="Additional data">
          <Pairs
            pairs={Object.entries(event.extra).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])}
          />
        </Section>
      )}
      {event._trimmed?.length ? (
        <p className="text-xs text-muted-foreground">
          This event was too large to keep whole, so some of it was cut: {event._trimmed.join(', ')}.
        </p>
      ) : null}
      <RawEvent event={event} />
    </div>
  )
}

/** The event as JSON, written only once opened: up to 900 KB of it, it would weigh down every issue page's HTML */
function RawEvent({ event }: { event: NormalizedEvent }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="group rounded-xl border" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="flex cursor-pointer items-center gap-1 px-4 py-3 text-sm font-medium">
        <IconChevronRight className="size-4 transition-transform group-open:rotate-90" />
        Raw event
      </summary>
      {open && (
        <pre className="max-h-[32rem] overflow-auto border-t bg-muted/30 p-4 font-mono text-xs">
          {JSON.stringify(event, null, 2)}
        </pre>
      )}
    </details>
  )
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

type Linked = Frame & { link?: string }

function Exception({ exception: e, link }: { exception: ExceptionValue; link: (frame: number) => string | undefined }) {
  const prefs = usePreferences()
  const [all, setAll] = useState(prefs.showOtherFrames)
  // Most recent call first, as Sentry shows them, unless the viewer reads them oldest first
  const frames = ordered(
    e.frames.map((f, j): Linked => ({ ...f, link: link(j) })),
    prefs.stackOrder,
  )
  const anyInApp = frames.some((f) => f.inApp)
  return (
    <Section
      title={e.synthetic ? 'Stack' : 'Exception'}
      aside={
        anyInApp &&
        frames.some((f) => !f.inApp) && (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setAll(!all)}
          >
            {all ? 'App frames only' : 'Show all frames'}
          </button>
        )
      }
    >
      {!e.synthetic && (
        <div className="mb-2">
          <p className="font-mono text-sm font-semibold break-words">{e.type}</p>
          {e.value && <p className="text-sm break-words whitespace-pre-wrap text-muted-foreground">{e.value}</p>}
          <p className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
            {e.mechanism && <span className="rounded bg-muted px-1.5 py-0.5">mechanism: {e.mechanism}</span>}
            {e.handled !== undefined && (
              <span
                className={cn('rounded px-1.5 py-0.5', e.handled ? 'bg-muted' : 'bg-destructive/10 text-destructive')}
              >
                {e.handled ? 'handled' : 'not handled'}
              </span>
            )}
          </p>
        </div>
      )}
      {frames.length === 0 ? (
        <p className="text-sm text-muted-foreground">This event came without a stack trace.</p>
      ) : (
        <Stack frames={frames} all={all} />
      )}
    </Section>
  )
}

/** Frames as the SDK sends them, oldest first, in the viewer's order */
const ordered = <T,>(frames: T[], order: 'newest' | 'oldest') => (order === 'newest' ? [...frames].reverse() : frames)

/** Frames in the viewer's order: runs of other code fold into one line, unless `all`; the crashing frame opens */
function Stack({ frames, all, className }: { frames: Linked[]; all: boolean; className?: string }) {
  const crash = usePreferences().stackOrder === 'newest' ? frames[0] : frames.at(-1)
  const anyInApp = frames.some((f) => f.inApp)
  const groups: { inApp: boolean; frames: Linked[] }[] = []
  for (const f of frames) {
    const inApp = f.inApp || !anyInApp || all
    const last = groups.at(-1)
    if (last && last.inApp === inApp && !inApp) last.frames.push(f)
    else groups.push({ inApp, frames: [f] })
  }
  return (
    <ol className={cn('divide-y overflow-hidden rounded-xl border', className)}>
      {groups.map((g, i) =>
        g.inApp ? (
          g.frames.map((f, j) => <FrameRow key={`${i}-${j}`} frame={f} open={f === crash} />)
        ) : (
          <FoldedFrames key={i} frames={g.frames} />
        ),
      )}
    </ol>
  )
}

/** The threads besides the crashed one, folded: each its name and top frame, opening to its stack */
function Threads({ event }: { event: NormalizedEvent }) {
  // The crashed one's stack is the exception's, and it kept no frames of its own
  const threads = (event.threads ?? []).filter((t) => t.frames.length)
  if (!threads.length) return null
  return (
    <details className="group/threads rounded-xl border">
      <summary className="flex cursor-pointer items-center gap-1 px-4 py-3 text-sm font-medium max-sm:py-3.5">
        <IconChevronRight className="size-4 transition-transform group-open/threads:rotate-90" />
        {event.exceptions.length ? 'Other threads' : 'Threads'}
        <span className="font-normal text-muted-foreground">{threads.length}</span>
      </summary>
      <ul className="divide-y border-t">
        {threads.map((t, i) => (
          <ThreadRow key={i} thread={t} />
        ))}
      </ul>
    </details>
  )
}

function ThreadRow({ thread: t }: { thread: Thread }) {
  const prefs = usePreferences()
  const frames = ordered(t.frames, prefs.stackOrder)
  // Its app's innermost frame, else the innermost
  const top = t.frames.findLast((f) => f.inApp) ?? t.frames.at(-1)
  return (
    <li>
      <details className="group/thread">
        <summary className="flex cursor-pointer items-start gap-1 px-4 py-2.5 max-sm:py-3">
          <IconChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open/thread:rotate-90" />
          <span className="grid min-w-0 gap-0.5">
            <span className="text-sm break-words">
              {t.name ?? (t.id !== undefined ? `Thread ${t.id}` : 'Thread')}
              {t.current && <span className="ml-2 text-xs text-muted-foreground">Current</span>}
            </span>
            {top && (
              <span className="font-mono text-xs break-all text-muted-foreground">
                {top.function ?? top.instructionAddr ?? top.filename ?? '?'}
                {top.package && <span className="font-sans"> in {basename(top.package)}</span>}
              </span>
            )}
          </span>
        </summary>
        <Stack frames={frames} all={prefs.showOtherFrames} className="mx-3 mb-3" />
      </details>
    </li>
  )
}

function FoldedFrames({ frames }: { frames: Linked[] }) {
  const [open, setOpen] = useState(false)
  if (open) return frames.map((f, i) => <FrameRow key={i} frame={f} />)
  return (
    <li>
      <button
        type="button"
        className="w-full bg-muted/30 px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        {frames.length} system or library frame{frames.length === 1 ? '' : 's'}
      </button>
    </li>
  )
}

const basename = (p?: string) => p?.split(/[\\/]/).at(-1)

function FrameRow({ frame: f, open }: { frame: Linked; open?: boolean }) {
  const where = f.filename ?? f.absPath ?? f.module
  const hasContext = !!f.context?.line
  const code = f.link && (
    <a
      href={f.link}
      target="_blank"
      rel="noreferrer"
      aria-label="Open in the repository"
      title="Open in the repository"
      className="-my-1.5 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground max-sm:-my-2.5 max-sm:size-10"
    >
      <IconExternalLink className="size-3.5" />
    </a>
  )
  const title = (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-left">
      <span className={cn('font-mono text-[0.8rem] break-all', f.inApp ? 'font-medium' : 'text-muted-foreground')}>
        {f.function ?? (f.instructionAddr ? f.instructionAddr : '?')}
      </span>
      {where && (
        <span className="font-mono text-xs break-all text-muted-foreground">
          {where}
          {f.lineno !== undefined && `:${f.lineno}`}
          {f.colno !== undefined && `:${f.colno}`}
        </span>
      )}
      {f.package && <span className="text-xs text-muted-foreground">in {basename(f.package)}</span>}
      {!f.function && f.instructionAddr && (
        <span className="text-xs text-amber-600 dark:text-amber-400">Not symbolicated</span>
      )}
    </span>
  )
  if (!hasContext)
    return (
      <li className="flex items-start justify-between gap-2 px-3 py-2">
        {title}
        {code}
      </li>
    )
  return (
    <li>
      <details open={open} className="group">
        <summary className="flex cursor-pointer items-start gap-1 px-3 py-2">
          <IconChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          <span className="flex min-w-0 flex-1 items-start justify-between gap-2">
            {title}
            {code}
          </span>
        </summary>
        <pre className="overflow-x-auto border-t bg-muted/30 py-2 font-mono text-xs leading-5">
          {f.context!.pre.map((l, i) => (
            <Line
              key={`p${i}`}
              n={f.lineno !== undefined ? f.lineno - f.context!.pre.length + i : undefined}
              text={l}
            />
          ))}
          <Line n={f.lineno} text={f.context!.line!} current />
          {f.context!.post.map((l, i) => (
            <Line key={`a${i}`} n={f.lineno !== undefined ? f.lineno + 1 + i : undefined} text={l} />
          ))}
        </pre>
      </details>
    </li>
  )
}

function Line({ n, text, current }: { n?: number; text: string; current?: boolean }) {
  return (
    <div className={cn('flex px-3', current && 'bg-amber-500/15')}>
      <span className="w-10 shrink-0 pr-3 text-right text-muted-foreground select-none">{n}</span>
      <span className="whitespace-pre">{text}</span>
    </div>
  )
}

function Breadcrumbs({ crumbs }: { crumbs: Breadcrumb[] }) {
  const [all, setAll] = useState(false)
  const newest = [...crumbs].reverse()
  const shown = all ? newest : newest.slice(0, 10)
  return (
    <Section
      title="Breadcrumbs"
      aside={
        crumbs.length > 10 && (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setAll(!all)}
          >
            {all ? 'Show fewer' : `Show all ${crumbs.length}`}
          </button>
        )
      }
    >
      <ol className="divide-y overflow-hidden rounded-xl border text-xs">
        {shown.map((b, i) => (
          <li key={i} className="grid grid-cols-[5.5rem_1fr] gap-2 px-3 py-2 sm:grid-cols-[7rem_1fr_auto]">
            <span className="truncate font-medium">{b.category ?? b.type ?? 'default'}</span>
            <span className="min-w-0 break-words">
              {b.message ??
                (b.data ? <span className="font-mono text-muted-foreground">{JSON.stringify(b.data)}</span> : '')}
            </span>
            {b.timestamp !== undefined && (
              <Time
                at={b.timestamp}
                style="seconds"
                className="text-muted-foreground tabular-nums max-sm:col-start-2"
              />
            )}
          </li>
        ))}
      </ol>
    </Section>
  )
}

function Request({ request: r }: { request: RequestInfo }) {
  return (
    <Section title="Request">
      <div className="grid grid-cols-1 gap-3">
        {(r.method || r.url) && (
          <p className="font-mono text-sm break-all">
            {r.method && <span className="mr-2 font-semibold">{r.method}</span>}
            {r.url}
          </p>
        )}
        {r.query && <Labelled label="Query string" text={r.query} />}
        {r.headers && (
          <div>
            <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">Headers</h4>
            <Pairs pairs={r.headers} />
          </div>
        )}
        {r.body && <Labelled label="Body" text={r.body} />}
      </div>
    </Section>
  )
}

function Labelled({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</h4>
      <pre className="max-h-64 overflow-auto rounded-xl border bg-muted/30 p-3 font-mono text-xs break-all whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  )
}

/** Names and values as a two-column table; on a phone each value goes under its name */
function Pairs({ pairs }: { pairs: [string, string][] }) {
  return (
    <div className="overflow-hidden rounded-xl border">
      <Table className="text-xs">
        <TableBody>
          {pairs.map(([k, v], i) => (
            <TableRow key={i} className="max-sm:flex max-sm:flex-col">
              <TableCell className="w-1/3 align-top whitespace-normal text-muted-foreground max-sm:w-full max-sm:pb-0">
                {k}
              </TableCell>
              <TableCell className="font-mono break-all whitespace-normal">{v}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function Contexts({ contexts }: { contexts: Record<string, unknown> }) {
  return (
    <Section title="Contexts">
      <div className="grid gap-3 sm:grid-cols-2">
        {Object.entries(contexts).map(([name, value]) => (
          <div key={name} className="rounded-xl border p-3">
            <h4 className="mb-1.5 text-xs font-medium text-muted-foreground uppercase">{name}</h4>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
              {value && typeof value === 'object' ? (
                Object.entries(value as Record<string, unknown>)
                  .filter(([k]) => k !== 'type')
                  .map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="font-mono break-all">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                    </div>
                  ))
              ) : (
                <dd className="col-span-2 font-mono">{String(value)}</dd>
              )}
            </dl>
          </div>
        ))}
      </div>
    </Section>
  )
}
