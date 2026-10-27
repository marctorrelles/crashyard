// An issue's own triage, beside its title: a bookmark, who it's assigned to, and its issue in a tracker; on a phone,
// these and the rest of the header but Resolve and Ignore in one More menu.
import { useRouter } from '@tanstack/react-router'
import {
  IconArrowsSplit,
  IconBrandGithub,
  IconCheck,
  IconChevronDown,
  IconDots,
  IconExternalLink,
  IconFlag,
  IconLink,
  IconStar,
  IconStarFilled,
  IconTrash,
  IconUser,
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
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { UnmergeDialog, useIssueChange } from '@/components/issue-actions'
import { PRIORITY_LABELS } from '@/components/priority'
import { assignIssue, bookmarkIssue, changeIssues, linkIssue } from '@/fns'
import type { NormalizedEvent } from '@/ingest/event'
import { PRIORITIES, type Priority } from '@/ingest/priority'

type Issue = { id: number; title: string; culprit: string; assignee: string | null; external_url: string | null }

function useRun() {
  const router = useRouter()
  return async (work: () => Promise<unknown>, done: string) => {
    try {
      await work()
      toast.success(done)
      await router.invalidate()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That didn’t work. Try again.')
    }
  }
}

export function BookmarkButton({ id, on }: { id: number; on: boolean }) {
  const run = useRun()
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={on ? 'Remove bookmark' : 'Bookmark'}
      aria-pressed={on}
      onClick={() => run(() => bookmarkIssue({ data: { id, on: !on } }), on ? 'Bookmark removed' : 'Bookmarked')}
    >
      {on ? <IconStarFilled className="text-amber-500" /> : <IconStar />}
    </Button>
  )
}

/** "Assign to": the viewer first, then everyone seen acting on issues */
export function AssignMenu({ issue, people, viewer }: { issue: Issue; people: string[]; viewer: string }) {
  const run = useRun()
  const assign = (assignee: string | null) =>
    run(
      () => assignIssue({ data: { id: issue.id, assignee } }),
      assignee ? `Assigned to ${assignee === viewer ? 'you' : assignee}` : 'Unassigned',
    )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="max-w-56">
          <IconUser data-icon="inline-start" />
          <span className="truncate">
            {issue.assignee ? (issue.assignee === viewer ? 'You' : issue.assignee) : 'Unassigned'}
          </span>
          <IconChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-72">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Assign to</DropdownMenuLabel>
        {people.map((p) => (
          <DropdownMenuItem key={p} onSelect={() => assign(p)} disabled={p === issue.assignee}>
            <span className="truncate">{p === viewer ? `${p} · you` : p}</span>
          </DropdownMenuItem>
        ))}
        {issue.assignee && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => assign(null)}>Unassign</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The issue as a tracker's new issue: its title, then the culprit, its crashyard link and the top frames */
export function trackerText(issue: Issue, event: NormalizedEvent | null, url: string) {
  const main = event?.exceptions.at(-1)
  const frames = [...(main?.frames ?? [])]
    .reverse()
    .slice(0, 5)
    .map((f) => {
      const where = [f.filename ?? f.module, f.lineno].filter((x) => x !== undefined).join(':')
      return `    ${f.function ?? f.instructionAddr ?? '?'}${where ? ` at ${where}` : ''}`
    })
  const body = [
    issue.culprit && `Culprit: \`${issue.culprit}\``,
    `crashyard: ${url}`,
    frames.length ? `\nTop frames, most recent first:\n\n${frames.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return { title: issue.title, body }
}

const isGitHub = (repo: string | null) => !!repo && URL.canParse(repo) && new URL(repo).hostname === 'github.com'

/** Where Track's items go: a new GitHub issue (with a GitHub repository), a new Linear one, the linked one's host */
function trackerLinks(issue: Issue, event: NormalizedEvent | null, repo: string | null, url: string) {
  const { title, body } = trackerText(issue, event, url)
  return {
    github: isGitHub(repo) ? `${repo}/issues/new?${new URLSearchParams({ title, body }).toString()}` : null,
    linear: `https://linear.app/new?${new URLSearchParams({ title, description: body }).toString()}`,
    host: issue.external_url && URL.canParse(issue.external_url) ? new URL(issue.external_url).hostname : null,
  }
}

const linkedName = (host: string | null) =>
  host === 'github.com' ? 'GitHub issue' : host === 'linear.app' ? 'Linear issue' : 'Linked issue'

/** Create a GitHub or Linear issue from this one, or link one by its address; a linked one opens from the header */
export function TrackerMenu({
  issue,
  event,
  repo,
  url,
}: {
  issue: Issue
  event: NormalizedEvent | null
  repo: string | null
  url: string
}) {
  const run = useRun()
  const [linking, setLinking] = useState(false)
  const { github, linear, host } = trackerLinks(issue, event, repo, url)
  return (
    <>
      {issue.external_url && (
        <Button variant="outline" asChild className="max-w-56">
          <a href={issue.external_url} target="_blank" rel="noreferrer">
            <IconExternalLink data-icon="inline-start" />
            <span className="truncate">{linkedName(host)}</span>
          </a>
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            <IconLink data-icon="inline-start" />
            Track issue
            <IconChevronDown data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {github && (
            <DropdownMenuItem asChild>
              <a href={github} target="_blank" rel="noreferrer">
                <IconBrandGithub />
                Create GitHub issue
              </a>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild>
            <a href={linear} target="_blank" rel="noreferrer">
              <IconExternalLink />
              Create Linear issue
            </a>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setLinking(true)}>
            <IconLink />
            {issue.external_url ? 'Change linked issue…' : 'Link issue…'}
          </DropdownMenuItem>
          {issue.external_url && (
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => run(() => linkIssue({ data: { id: issue.id, url: null } }), 'Unlinked')}
            >
              Unlink issue
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <LinkIssueDialog issue={issue} open={linking} onOpenChange={setLinking} />
    </>
  )
}

/** Link issue: a tracker's address, opened from the header */
function LinkIssueDialog({
  issue,
  open,
  onOpenChange,
}: {
  issue: Issue
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const run = useRun()
  const [link, setLink] = useState('')
  const [was, setWas] = useState(false)
  // Filled with the linked one each time it opens
  if (open !== was) {
    setWas(open)
    if (open) setLink(issue.external_url ?? '')
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            onOpenChange(false)
            void run(() => linkIssue({ data: { id: issue.id, url: link } }), 'Issue linked')
          }}
        >
          <DialogHeader>
            <DialogTitle>Link issue</DialogTitle>
            <DialogDescription>
              Paste the address of the issue in GitHub, Linear or any tracker. It opens from this issue’s header.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="external-url">Issue address</Label>
            <Input
              id="external-url"
              type="url"
              required
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://github.com/owner/repo/issues/12"
            />
          </div>
          <DialogFooter>
            <Button type="submit">Link issue</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * On a phone, everything in the issue's header but Resolve and Ignore, in one menu: priority, assignee, bookmark,
 * tracker links, Unmerge and Delete
 */
export function IssueMoreMenu({
  issue,
  bookmarked,
  people,
  viewer,
  event,
  repo,
  url,
  merged,
  now,
  className,
}: {
  issue: Issue & { priority: Priority }
  bookmarked: boolean
  people: string[]
  viewer: string
  event: NormalizedEvent | null
  repo: string | null
  url: string
  merged: boolean
  now: number
  className?: string
}) {
  const run = useRun()
  const change = useIssueChange([issue.id])
  const [linking, setLinking] = useState(false)
  const [unmerging, setUnmerging] = useState(false)
  const { github, linear, host } = trackerLinks(issue, event, repo, url)
  const assign = (assignee: string | null) =>
    run(
      () => assignIssue({ data: { id: issue.id, assignee } }),
      assignee ? `Assigned to ${assignee === viewer ? 'you' : assignee}` : 'Unassigned',
    )
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className={className}>
            <IconDots data-icon="inline-start" />
            More
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <IconFlag />
              Priority
              <span className="ml-auto text-xs text-muted-foreground">{PRIORITY_LABELS[issue.priority]}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {PRIORITIES.map((p) => (
                <DropdownMenuItem
                  key={p}
                  disabled={p === issue.priority}
                  onSelect={() =>
                    run(
                      () => changeIssues({ data: { ids: [issue.id], action: 'priority', priority: p } }),
                      `Priority set to ${PRIORITY_LABELS[p].toLowerCase()}`,
                    )
                  }
                >
                  {PRIORITY_LABELS[p]}
                  {p === issue.priority && <IconCheck className="ml-auto" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <IconUser />
              Assign to
              <span className="ml-auto max-w-24 truncate text-xs text-muted-foreground">
                {issue.assignee ? (issue.assignee === viewer ? 'You' : issue.assignee) : 'No one'}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-w-72">
              {people.map((p) => (
                <DropdownMenuItem key={p} onSelect={() => assign(p)} disabled={p === issue.assignee}>
                  <span className="truncate">{p === viewer ? `${p} · you` : p}</span>
                </DropdownMenuItem>
              ))}
              {issue.assignee && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => assign(null)}>Unassign</DropdownMenuItem>
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            onSelect={() =>
              run(
                () => bookmarkIssue({ data: { id: issue.id, on: !bookmarked } }),
                bookmarked ? 'Bookmark removed' : 'Bookmarked',
              )
            }
          >
            {bookmarked ? <IconStarFilled className="text-amber-500" /> : <IconStar />}
            {bookmarked ? 'Remove bookmark' : 'Bookmark'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {issue.external_url && (
            <DropdownMenuItem asChild>
              <a href={issue.external_url} target="_blank" rel="noreferrer">
                <IconExternalLink />
                Open {linkedName(host)}
              </a>
            </DropdownMenuItem>
          )}
          {github && (
            <DropdownMenuItem asChild>
              <a href={github} target="_blank" rel="noreferrer">
                <IconBrandGithub />
                Create GitHub issue
              </a>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild>
            <a href={linear} target="_blank" rel="noreferrer">
              <IconExternalLink />
              Create Linear issue
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setLinking(true)}>
            <IconLink />
            {issue.external_url ? 'Change linked issue…' : 'Link issue…'}
          </DropdownMenuItem>
          {merged && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setUnmerging(true)}>
                <IconArrowsSplit />
                Unmerge…
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => change({ action: 'delete' }, 'Deleted')}>
            <IconTrash />
            Delete
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => change({ action: 'delete', discard: true }, 'Deleted and discarded future events')}
          >
            <IconTrash />
            Delete and discard future events
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <LinkIssueDialog issue={issue} open={linking} onOpenChange={setLinking} />
      {merged && <UnmergeDialog id={issue.id} now={now} open={unmerging} onOpenChange={setUnmerging} />}
    </>
  )
}

/** What a notification's link asks for (`?do=` on the issue page) */
export type PromptAction = 'resolve' | 'ignore' | 'assign'

/** A notification's Resolve, Ignore or Assign to me, opened from Slack, Discord or email: asked once more here, signed
 *  in, as mail scanners and link previews open links on their own */
export function ActionPrompt({
  issue,
  status,
  viewer,
  action,
  onClose,
}: {
  issue: Issue
  status: string
  viewer: string
  action: PromptAction
  onClose: () => void
}) {
  const run = useRun()
  const change = useIssueChange([issue.id])
  const already =
    action === 'resolve' && status === 'resolved'
      ? 'It’s already resolved.'
      : action === 'ignore' && status === 'ignored'
        ? 'It’s already ignored.'
        : action === 'assign' && issue.assignee === viewer
          ? 'It’s already assigned to you.'
          : null
  const ask = {
    resolve: { title: 'Resolve this issue?', button: 'Resolve' },
    ignore: { title: 'Ignore this issue until it escalates?', button: 'Ignore' },
    assign: { title: 'Assign this issue to you?', button: 'Assign to me' },
  }[action]
  const confirm = async () => {
    if (action === 'resolve') await change({ action: 'resolve' }, 'Resolved')
    else if (action === 'ignore')
      await change({ action: 'ignore', untilEscalating: true }, 'Ignored until it escalates')
    else await run(() => assignIssue({ data: { id: issue.id, assignee: viewer } }), 'Assigned to you')
    onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="pr-6 break-words">{already ? issue.title : ask.title}</DialogTitle>
          <DialogDescription className="break-words">{already ?? issue.title}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" className="max-sm:h-10" onClick={onClose}>
            {already ? 'Close' : 'Cancel'}
          </Button>
          {!already && (
            <Button className="max-sm:h-10" onClick={confirm}>
              {ask.button}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
