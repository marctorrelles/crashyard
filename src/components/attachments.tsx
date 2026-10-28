// An event's attachments: each with its size and a download, images as a thumbnail that opens full size, and the view
// hierarchy sentry-cocoa and sentry-android send as an indented tree. Files come from /attachments/<id>, behind sign-in.
import { IconChevronRight, IconDownload, IconFile } from '@tabler/icons-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

export type Attachment = { id: number; filename: string; size: number; image: boolean }

const fileSize = (n: number) =>
  n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
const urlOf = (a: Attachment) => `/attachments/${a.id}`
/** sentry-cocoa and sentry-android name it so (attachment type `event.view_hierarchy`) */
const isViewHierarchy = (a: Attachment) => /^view[-_]hierarchy\.json$/i.test(a.filename)

export function Attachments({ attachments }: { attachments: Attachment[] }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">Attachments</h3>
      <ul className="divide-y overflow-hidden rounded-xl border">
        {attachments.map((a) => (
          <li key={a.id} className="grid gap-2 px-3 py-2">
            <div className="flex items-center gap-3">
              {a.image ? (
                <Thumbnail attachment={a} />
              ) : (
                <span className="flex size-12 shrink-0 items-center justify-center rounded-md border bg-muted/50">
                  <IconFile className="size-5 text-muted-foreground" />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs">{a.filename}</span>
                <span className="text-xs text-muted-foreground">{fileSize(a.size)}</span>
              </span>
              <Button asChild variant="outline" size="sm" className="max-sm:h-10">
                <a href={urlOf(a)} download={a.filename}>
                  <IconDownload />
                  Download
                </a>
              </Button>
            </div>
            {isViewHierarchy(a) && <ViewHierarchy attachment={a} />}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Thumbnail({ attachment: a }: { attachment: Attachment }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={`Open ${a.filename}`}
          className="size-12 shrink-0 overflow-hidden rounded-md border bg-muted"
        >
          <img src={urlOf(a)} alt="" loading="lazy" className="size-full object-cover" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_1fr] sm:max-w-4xl">
        <DialogTitle className="truncate pr-8 font-mono text-xs">{a.filename}</DialogTitle>
        <div className="min-h-0 overflow-auto">
          <img src={urlOf(a)} alt={a.filename} className="mx-auto max-w-full" />
        </div>
      </DialogContent>
    </Dialog>
  )
}

type ViewNode = {
  type?: string
  identifier?: string
  x?: number
  y?: number
  width?: number
  height?: number
  visible?: boolean
  children?: ViewNode[]
}

const MAX_NODES = 2000

function ViewHierarchy({ attachment: a }: { attachment: Attachment }) {
  const [state, setState] = useState<{ windows: ViewNode[] } | 'loading' | 'error' | null>(null)
  const load = async () => {
    if (state) return
    setState('loading')
    try {
      const json = (await (await fetch(urlOf(a))).json()) as { windows?: ViewNode[] }
      setState({ windows: Array.isArray(json.windows) ? json.windows : [] })
    } catch {
      setState('error')
    }
  }
  // Depth first, flattened, at most 2000 nodes
  const rows: { node: ViewNode; depth: number }[] = []
  const walk = (nodes: ViewNode[], depth: number) => {
    for (const node of nodes) {
      if (rows.length >= MAX_NODES || !node || typeof node !== 'object') return
      rows.push({ node, depth })
      if (Array.isArray(node.children)) walk(node.children, depth + 1)
    }
  }
  if (state && typeof state === 'object') walk(state.windows, 0)
  return (
    <details className="group/views" onToggle={(e) => e.currentTarget.open && load()}>
      <summary className="flex cursor-pointer items-center gap-1 py-1 text-xs text-muted-foreground hover:text-foreground max-sm:py-2.5">
        <IconChevronRight className="size-3.5 transition-transform group-open/views:rotate-90" />
        Show view hierarchy
      </summary>
      <div className="mt-1 max-h-96 overflow-auto rounded-lg border bg-muted/30 py-2 font-mono text-xs">
        {state === 'loading' && <p className="px-3 text-muted-foreground">Loading…</p>}
        {state === 'error' && (
          <p className="px-3 text-muted-foreground">This file isn’t a view hierarchy crashyard can read.</p>
        )}
        {typeof state === 'object' && state && !rows.length && (
          <p className="px-3 text-muted-foreground">This view hierarchy is empty.</p>
        )}
        {rows.map(({ node, depth }, i) => (
          <div
            key={i}
            className="flex flex-wrap gap-x-2 px-3 whitespace-nowrap"
            style={{ paddingLeft: `${0.75 + depth}rem` }}
          >
            <span className={node.visible === false ? 'text-muted-foreground' : 'font-medium'}>
              {String(node.type ?? 'View')}
            </span>
            {node.identifier && <span className="text-sky-600 dark:text-sky-400">#{String(node.identifier)}</span>}
            {/* A file the app sent, any shape: only numbers drawn as numbers, never an object as a child */}
            {typeof node.width === 'number' && typeof node.height === 'number' && (
              <span className="text-muted-foreground">
                {Number(node.x) || 0}, {Number(node.y) || 0} · {node.width} × {node.height}
              </span>
            )}
          </div>
        ))}
        {rows.length >= MAX_NODES && (
          <p className="px-3 text-muted-foreground">Only the first 2,000 views are shown.</p>
        )}
      </div>
    </details>
  )
}
