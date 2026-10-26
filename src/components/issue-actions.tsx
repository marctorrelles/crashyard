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
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { changeIssues, getMergedFingerprints, mergeIssues, unmergeIssue } from '@/fns'
import type { MergedFingerprint } from '@/data/issues'

type Change =
  | { action: 'resolve'; inRelease?: boolean; current?: boolean; release?: string }
  | { action: 'ignore'; forEvents?: number; forUsers?: number; until?: number; untilEscalating?: boolean }
  | { action: 'reopen' }
  | { action: 'delete'; discard?: boolean }

const HOUR = 3_600_000

export function IssueActions({
  ids,
  status,
  canMerge,
  onDone,
  size = 'default',
  lastRelease,
  releases,
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
}) {
  const router = useRouter()
  const [picking, setPicking] = useState(false)
  const [release, setRelease] = useState('')
  const many = ids.length > 1 ? ` ${ids.length} issues` : ''
  const run = async (change: Change, done: string) => {
    if (
      change.action === 'delete' &&
      !confirm(
        change.discard
          ? `Delete${many || ' this issue'} and all its events, and drop every future event like them? This can’t be undone.`
          : `Delete${many || ' this issue'} and all its events? This can’t be undone.`,
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
          <Button size={size === 'sm' ? 'icon-sm' : 'icon'} variant="ghost" aria-label={`Delete${many}`}>
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

/** Unmerge on a merged issue: its merged fingerprints with their events, one moved back out to an issue of its own */
export function UnmergeButton({ id, now }: { id: number; now: number }) {
  const router = useRouter()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<MergedFingerprint[] | null>(null)
  const [chosen, setChosen] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async (next: boolean) => {
    setOpen(next)
    if (!next) return
    setList(null)
    const fingerprints = await getMergedFingerprints({ data: { id } })
    setList(fingerprints)
    setChosen(fingerprints[0]?.fingerprint ?? '')
  }
  const unmerge = async () => {
    setBusy(true)
    try {
      const made = await unmergeIssue({ data: { id, fingerprint: chosen } })
      setOpen(false)
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
    <Dialog open={open} onOpenChange={(next) => void load(next)}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <IconArrowsSplit data-icon="inline-start" />
          Unmerge
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unmerge</DialogTitle>
          <DialogDescription>
            Pick what was merged into this issue. Its events, days and tags move back to an issue of its own, and new
            events go there too.
          </DialogDescription>
        </DialogHeader>
        {!list ? (
          <p className="text-sm text-muted-foreground">Loading what was merged…</p>
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
                  <span className="text-xs text-muted-foreground">
                    {f.events === 1 ? '1 event' : `${count(f.events)} events`}
                    {f.last ? (
                      <>
                        {' · last '}
                        <Ago at={f.last} now={now} />
                      </>
                    ) : null}
                    {' · '}
                    <span className="font-mono">{f.fingerprint.slice(0, 12)}</span>
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
