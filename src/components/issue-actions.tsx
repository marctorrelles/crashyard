// What can be done to issues, for one (its page) or many (the list): resolve, ignore, reopen, merge, delete.
import { useNavigate, useRouter } from '@tanstack/react-router'
import {
  IconArrowsSplit,
  IconCheck,
  IconChevronDown,
  IconEyeOff,
  IconGitMerge,
  IconRotate,
  IconTrash,
} from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Ago, count } from '@/components/bits'
import { Loader } from '@/components/shell'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { changeIssues, getMergedFingerprints, mergeIssues, unmergeIssue } from '@/fns'
import type { MergedFingerprint } from '@/data/issues'
import { cn } from '@/lib/utils'

type Change =
  | { action: 'resolve'; inRelease?: boolean; current?: boolean; release?: string }
  | { action: 'ignore'; forEvents?: number; forUsers?: number; until?: number; untilEscalating?: boolean }
  | { action: 'reopen' }
  | { action: 'delete'; discard?: boolean }

const HOUR = 3_600_000

/** A change to issues, asking first before a delete, then a toast; the header's More menu on a phone uses it too */
export function useIssueChange(ids: number[], onDone?: (action: Change['action']) => void) {
  const router = useRouter()
  return async (change: Change, done: string) => {
    const what = ids.length > 1 ? `${ids.length} issues` : 'this issue'
    const theirs = ids.length > 1 ? 'their' : 'its'
    if (
      change.action === 'delete' &&
      !confirm(
        change.discard
          ? `Delete ${what} and discard ${theirs} future events? This can’t be undone.`
          : `Delete ${what} and all ${theirs} events? This can’t be undone.`,
      )
    )
      return
    try {
      await changeIssues({ data: { ids, ...change } })
      toast.success(done)
      onDone?.(change.action)
      await router.invalidate()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Something went wrong. Try again.')
    }
  }
}

export function IssueActions({
  ids,
  status,
  canMerge,
  onDone,
  size = 'default',
  lastRelease,
  releases,
  deleteOnPhone = true,
}: {
  ids: number[]
  status?: 'unresolved' | 'resolved' | 'ignored'
  canMerge?: boolean
  /** One issue's latest release, named in "Resolve in current release" */
  lastRelease?: string | null
  /** The project's releases, for "Resolve in a release…" on one issue */
  releases?: string[]
  onDone?: (change: Change['action'] | 'merge') => void
  size?: 'default' | 'sm'
  /** False on the issue's page, where a phone has Delete in the header's More menu */
  deleteOnPhone?: boolean
}) {
  const router = useRouter()
  const [picking, setPicking] = useState(false)
  const [release, setRelease] = useState('')
  const many = ids.length > 1 ? ` ${ids.length} issues` : ''
  const run = useIssueChange(ids, onDone)
  const merge = async () => {
    if (!confirm(`Merge ${ids.length} issues into the first one? Their events, and any future ones, move to it.`))
      return
    try {
      await mergeIssues({ data: { ids } })
      toast.success('Merged')
      onDone?.('merge')
      await router.invalidate()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The issues couldn’t be merged')
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status && status !== 'unresolved' ? (
        <Button size={size} variant="outline" onClick={() => run({ action: 'reopen' }, 'Reopened')}>
          <IconRotate data-icon="inline-start" />
          {status === 'resolved' ? 'Reopen' : 'Stop ignoring'}
        </Button>
      ) : (
        <>
          <div className="flex">
            <Button size={size} className="rounded-r-none" onClick={() => run({ action: 'resolve' }, 'Resolved')}>
              <IconCheck data-icon="inline-start" />
              Resolve
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size={size}
                  className="rounded-l-none border-l border-primary-foreground/20 px-1.5"
                  aria-label="More ways to resolve"
                >
                  <IconChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => run({ action: 'resolve' }, 'Resolved')}>Resolve now</DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => run({ action: 'resolve', inRelease: true }, 'Resolved in the next release')}
                >
                  Resolve in next release
                  <span className="ml-auto pl-3 text-xs text-muted-foreground">reopens only in another</span>
                </DropdownMenuItem>
                {lastRelease !== null && (
                  <DropdownMenuItem
                    onSelect={() =>
                      run(
                        { action: 'resolve', current: true },
                        lastRelease ? `Resolved in ${lastRelease}` : 'Resolved in the current release',
                      )
                    }
                  >
                    Resolve in current release
                    <span className="ml-auto max-w-40 truncate pl-3 text-xs text-muted-foreground">
                      {lastRelease ?? 'each one’s latest'}
                    </span>
                  </DropdownMenuItem>
                )}
                {!!releases?.length && (
                  <DropdownMenuItem
                    onSelect={() => {
                      setRelease(releases[0])
                      setPicking(true)
                    }}
                  >
                    Resolve in a release…
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="flex">
            <Button
              size={size}
              variant="outline"
              className="rounded-r-none"
              onClick={() => run({ action: 'ignore', untilEscalating: true }, 'Ignored until it escalates')}
            >
              <IconEyeOff data-icon="inline-start" />
              Ignore
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size={size}
                  variant="outline"
                  className="rounded-l-none border-l-0 px-1.5"
                  aria-label="More ways to ignore"
                >
                  <IconChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem
                  onSelect={() => run({ action: 'ignore', untilEscalating: true }, 'Ignored until it escalates')}
                >
                  Until it escalates
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => run({ action: 'ignore' }, 'Ignored')}>Forever</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted-foreground">Until it happens</DropdownMenuLabel>
                {[10, 100, 1000].map((n) => (
                  <DropdownMenuItem
                    key={n}
                    onSelect={() => run({ action: 'ignore', forEvents: n }, `Ignored for ${n} more events`)}
                  >
                    {n} more times
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted-foreground">Until it affects</DropdownMenuLabel>
                {[10, 100, 1000].map((n) => (
                  <DropdownMenuItem
                    key={n}
                    onSelect={() => run({ action: 'ignore', forUsers: n }, `Ignored until ${n} more users`)}
                  >
                    {n} more users
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted-foreground">For</DropdownMenuLabel>
                {(
                  [
                    ['an hour', HOUR],
                    ['a day', 24 * HOUR],
                    ['a week', 168 * HOUR],
                  ] as const
                ).map(([label, ms]) => (
                  <DropdownMenuItem
                    key={label}
                    onSelect={() => run({ action: 'ignore', until: Date.now() + ms }, `Ignored for ${label}`)}
                  >
                    {label[0].toUpperCase() + label.slice(1)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>
      )}
      {releases && (
        <Dialog open={picking} onOpenChange={setPicking}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Resolve in a release</DialogTitle>
              <DialogDescription>
                The issue reopens if it happens in this release or a newer one. Older releases don’t reopen it.
              </DialogDescription>
            </DialogHeader>
            <Select value={release} onValueChange={setRelease}>
              <SelectTrigger className="w-full" aria-label="Release">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {releases.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DialogFooter>
              <Button
                onClick={async () => {
                  setPicking(false)
                  await run({ action: 'resolve', release }, `Resolved in ${release}`)
                }}
              >
                Resolve in {release}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {canMerge && (
        <Button size={size} variant="outline" onClick={merge}>
          <IconGitMerge data-icon="inline-start" />
          Merge
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size={size === 'sm' ? 'icon-sm' : 'icon'}
            variant="ghost"
            aria-label={`Delete${many}`}
            className={cn(!deleteOnPhone && 'max-sm:hidden')}
          >
            <IconTrash />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onSelect={() => run({ action: 'delete' }, 'Deleted')}>
            Delete
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => run({ action: 'delete', discard: true }, 'Deleted and discarded future events')}
          >
            Delete and discard future events
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** Unmerge on a merged issue: its button, opening `UnmergeDialog` */
export function UnmergeButton({ id, now, className }: { id: number; now: number; className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" className={className} onClick={() => setOpen(true)}>
        <IconArrowsSplit data-icon="inline-start" />
        Unmerge
      </Button>
      <UnmergeDialog id={id} now={now} open={open} onOpenChange={setOpen} />
    </>
  )
}

/**
 * The fingerprints merged into an issue, each with what tells it apart (its events, first and last seen, its top
 * in-app frame or message), one moved back out to an issue of its own
 */
export function UnmergeDialog({
  id,
  now,
  open,
  onOpenChange,
}: {
  id: number
  now: number
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const navigate = useNavigate()
  const [list, setList] = useState<MergedFingerprint[] | null>(null)
  const [chosen, setChosen] = useState('')
  const [busy, setBusy] = useState(false)
  // Read again each time it opens
  const [was, setWas] = useState(false)
  if (open !== was) {
    setWas(open)
    if (open) setList(null)
  }
  useEffect(() => {
    if (!open) return
    let live = true
    void getMergedFingerprints({ data: { id } }).then((fingerprints) => {
      if (!live) return
      setList(fingerprints)
      setChosen(fingerprints[0]?.fingerprint ?? '')
    })
    return () => {
      live = false
    }
  }, [open, id])
  const unmerge = async () => {
    setBusy(true)
    try {
      const made = await unmergeIssue({ data: { id, fingerprint: chosen } })
      onOpenChange(false)
      toast.success(made ? 'Unmerged into a new issue' : 'Unmerged. Its next event opens a new issue')
      await router.invalidate()
      if (made) await navigate({ to: '/issues/$issueId', params: { issueId: String(made) } })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The issue couldn’t be unmerged. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unmerge</DialogTitle>
          <DialogDescription>
            Pick what was merged into this issue. Its events, days and tags move back to an issue of its own, and new
            events go there too.
          </DialogDescription>
        </DialogHeader>
        {!list ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader />
            Loading what was merged…
          </p>
        ) : (
          <RadioGroup value={chosen} onValueChange={setChosen} className="max-h-80 overflow-auto">
            {list.map((f) => (
              <Label
                key={f.fingerprint}
                className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal has-data-[state=checked]:border-primary"
              >
                <RadioGroupItem value={f.fingerprint} className="mt-0.5" />
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate text-sm">{f.title ?? 'No events kept'}</span>
                  {f.frame && <span className="truncate font-mono text-xs">{f.frame}</span>}
                  <span className="text-xs text-muted-foreground">
                    {f.events === 1 ? '1 event' : `${count(f.events)} events`}
                    {f.first ? (
                      <>
                        {' · first '}
                        <Ago at={f.first} now={now} />
                      </>
                    ) : null}
                    {f.last ? (
                      <>
                        {' · last '}
                        <Ago at={f.last} now={now} />
                      </>
                    ) : null}
                  </span>
                </span>
              </Label>
            ))}
          </RadioGroup>
        )}
        <DialogFooter>
          <Button onClick={unmerge} disabled={busy || !chosen}>
            Unmerge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
