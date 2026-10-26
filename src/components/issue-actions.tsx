// What can be done to issues, for one (its page) or many (the list): resolve, ignore, reopen, merge, delete.
import { useRouter } from '@tanstack/react-router'
import { IconCheck, IconChevronDown, IconEyeOff, IconGitMerge, IconRotate, IconTrash } from '@tabler/icons-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { changeIssues, mergeIssues } from '@/fns'

type Change =
  | { action: 'resolve'; inRelease?: boolean }
  | { action: 'ignore'; forEvents?: number; until?: number }
  | { action: 'reopen' }
  | { action: 'delete' }

const HOUR = 3_600_000

export function IssueActions({
  ids,
  status,
  canMerge,
  onDone,
  size = 'default',
}: {
  ids: number[]
  status?: 'unresolved' | 'resolved' | 'ignored'
  canMerge?: boolean
  onDone?: (change: Change['action'] | 'merge') => void
  size?: 'default' | 'sm'
}) {
  const router = useRouter()
  const many = ids.length > 1 ? ` ${ids.length} issues` : ''
  const run = async (change: Change, done: string) => {
    if (
      change.action === 'delete' &&
      !confirm(`Delete${many || ' this issue'} and all its events? This can’t be undone.`)
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
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size={size} variant="outline">
                <IconEyeOff data-icon="inline-start" />
                Ignore
                <IconChevronDown data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
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
        </>
      )}
      {canMerge && (
        <Button size={size} variant="outline" onClick={merge}>
          <IconGitMerge data-icon="inline-start" />
          Merge
        </Button>
      )}
      <Button
        size={size === 'sm' ? 'icon-sm' : 'icon'}
        variant="ghost"
        aria-label={`Delete${many}`}
        onClick={() => run({ action: 'delete' }, 'Deleted')}
      >
        <IconTrash />
      </Button>
    </div>
  )
}
