// An issue's own triage, beside its title: a bookmark, who it's assigned to, and its issue in a tracker.
import { useRouter } from '@tanstack/react-router'
import {
  IconBrandGithub,
  IconChevronDown,
  IconExternalLink,
  IconLink,
  IconStar,
  IconStarFilled,
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { assignIssue, bookmarkIssue, linkIssue } from '@/fns'
import type { NormalizedEvent } from '@/ingest/event'

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
  const [link, setLink] = useState('')
  const { title, body } = trackerText(issue, event, url)
  const github = isGitHub(repo) ? `${repo}/issues/new?${new URLSearchParams({ title, body }).toString()}` : null
  const linear = `https://linear.app/new?${new URLSearchParams({ title, description: body }).toString()}`
  const host = issue.external_url && URL.canParse(issue.external_url) ? new URL(issue.external_url).hostname : null
  return (
    <>
      {issue.external_url && (
        <Button variant="outline" asChild className="max-w-56">
          <a href={issue.external_url} target="_blank" rel="noreferrer">
            <IconExternalLink data-icon="inline-start" />
            <span className="truncate">
              {host === 'github.com' ? 'GitHub issue' : host === 'linear.app' ? 'Linear issue' : 'Linked issue'}
            </span>
          </a>
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" aria-label="Issue tracker">
            <IconLink data-icon="inline-start" />
            Track
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
          <DropdownMenuItem
            onSelect={() => {
              setLink(issue.external_url ?? '')
              setLinking(true)
            }}
          >
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
      <Dialog open={linking} onOpenChange={setLinking}>
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              setLinking(false)
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
    </>
  )
}
