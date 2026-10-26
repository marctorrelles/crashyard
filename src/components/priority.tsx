// An issue's priority as a badge that opens a menu to change it, in the list and on the issue.
import { useRouter } from '@tanstack/react-router'
import { IconCheck, IconChevronDown } from '@tabler/icons-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { changeIssues } from '@/fns'
import { PRIORITIES, type Priority } from '@/ingest/priority'
import { cn } from '@/lib/utils'

export const PRIORITY_LABELS: Record<Priority, string> = { high: 'High', medium: 'Medium', low: 'Low' }
const TONES: Record<Priority, string> = {
  high: 'border-red-500/40 text-red-700 dark:text-red-400',
  medium: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
  low: 'text-muted-foreground',
}

export function PriorityBadge({ id, priority, className }: { id: number; priority: Priority; className?: string }) {
  const router = useRouter()
  const set = async (next: Priority) => {
    if (next === priority) return
    try {
      await changeIssues({ data: { ids: [id], action: 'priority', priority: next } })
      toast.success(`Priority set to ${PRIORITY_LABELS[next].toLowerCase()}`)
      await router.invalidate()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The priority couldn’t be changed. Try again.')
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Priority ${PRIORITY_LABELS[priority]}. Change priority`}
          className={cn(
            'relative z-10 inline-flex items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50 max-sm:min-h-10',
            className,
          )}
        >
          <Badge variant="outline" className={cn('gap-0.5 pr-1', TONES[priority])}>
            {PRIORITY_LABELS[priority]}
            <IconChevronDown className="size-3 opacity-60" />
          </Badge>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Priority</DropdownMenuLabel>
        {PRIORITIES.map((p) => (
          <DropdownMenuItem key={p} onSelect={() => set(p)}>
            {PRIORITY_LABELS[p]}
            {p === priority && <IconCheck className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
