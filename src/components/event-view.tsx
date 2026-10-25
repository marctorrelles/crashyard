// One event, as Sentry shows it: the exception with its stack (where it happened first, other code folded),
// breadcrumbs, tags, contexts and the raw JSON.
import { ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import type { Breadcrumb, ExceptionValue, Frame, NormalizedEvent } from '@/ingest/event'
import { cn } from '@/lib/utils'

export function EventView({ event }: { event: NormalizedEvent }) {
  // The thrown exception first (Sentry sends the chain oldest first)
  const exceptions = [...event.exceptions].reverse()
  return (
    <div className="grid gap-6">
      {event.missingDebugFiles?.length ? (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="font-medium">Some frames are addresses: their debug files weren’t uploaded.</p>
          <ul className="mt-1 grid gap-0.5 text-xs">
            {event.missingDebugFiles.map((m) => (
              <li key={m.debugId} className="font-mono break-all">
                {m.type === 'proguard' ? 'ProGuard mapping' : (m.codeFile?.split('/').at(-1) ?? m.type)} · {m.debugId}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted-foreground">
            Upload them (the project’s settings say how), and this event is read again.
          </p>
        </div>
      ) : null}
      {exceptions.length > 0 ? (
        exceptions.map((e, i) => <Exception key={i} exception={e} />)
      ) : (
        <Section title="Message">
          <pre className="text-sm whitespace-pre-wrap">{event.message || event.title}</pre>
        </Section>
      )}
      {event.breadcrumbs.length > 0 && <Breadcrumbs crumbs={event.breadcrumbs} />}
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
      <details className="group rounded-xl border">
        <summary className="flex cursor-pointer items-center gap-1 px-4 py-3 text-sm font-medium">
          <ChevronRightIcon className="size-4 transition-transform group-open:rotate-90" />
          Raw event
        </summary>
        <pre className="max-h-[32rem] overflow-auto border-t bg-muted/30 p-4 font-mono text-xs">
          {JSON.stringify(event, null, 2)}
        </pre>
      </details>
    </div>
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

function Exception({ exception: e }: { exception: ExceptionValue }) {
  const [all, setAll] = useState(false)
  // Most recent call first, as Sentry shows them
  const frames = [...e.frames].reverse()
  const anyInApp = frames.some((f) => f.inApp)
  // Runs of other code fold into one line, unless asked for every frame
  const groups: { inApp: boolean; frames: Frame[] }[] = []
  for (const f of frames) {
    const inApp = f.inApp || !anyInApp || all
    const last = groups.at(-1)
    if (last && last.inApp === inApp && !inApp) last.frames.push(f)
    else groups.push({ inApp, frames: [f] })
  }
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
            {all ? 'Only my code' : 'Every frame'}
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
        <p className="text-sm text-muted-foreground">No stack trace came with it.</p>
      ) : (
        <ol className="divide-y overflow-hidden rounded-xl border">
          {groups.map((g, i) =>
            g.inApp ? (
              g.frames.map((f, j) => <FrameRow key={`${i}-${j}`} frame={f} open={i === 0 && j === 0} />)
            ) : (
              <FoldedFrames key={i} frames={g.frames} />
            ),
          )}
        </ol>
      )}
    </Section>
  )
}

function FoldedFrames({ frames }: { frames: Frame[] }) {
  const [open, setOpen] = useState(false)
  if (open) return frames.map((f, i) => <FrameRow key={i} frame={f} />)
  return (
    <li>
      <button
        type="button"
        className="w-full bg-muted/30 px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        {frames.length} frame{frames.length === 1 ? '' : 's'} of other code
      </button>
    </li>
  )
}

const basename = (p?: string) => p?.split(/[\\/]/).at(-1)

function FrameRow({ frame: f, open }: { frame: Frame; open?: boolean }) {
  const where = f.filename ?? f.absPath ?? f.module
  const hasContext = !!f.context?.line
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
        <span className="text-xs text-amber-600 dark:text-amber-400">not symbolicated</span>
      )}
    </span>
  )
  if (!hasContext) return <li className="px-3 py-2">{title}</li>
  return (
    <li>
      <details open={open} className="group">
        <summary className="flex cursor-pointer items-start gap-1 px-3 py-2">
          <ChevronRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          {title}
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
            {all ? 'Fewer' : `All ${crumbs.length}`}
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
              <time className="text-muted-foreground tabular-nums max-sm:col-start-2">
                {new Date(b.timestamp).toISOString().slice(11, 23)}
              </time>
            )}
          </li>
        ))}
      </ol>
    </Section>
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
