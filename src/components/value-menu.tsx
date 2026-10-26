// A value shown on a page, as a menu: show only this, exclude this, copy it.
import { ClipboardIcon, MinusCircleIcon, PlusCircleIcon } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

/** `children` is the value as the page shows it; a tap opens the menu. Its tap area reaches 40 px high on a phone. */
export function ValueMenu({
  field,
  value,
  onInclude,
  onExclude,
  className,
  children,
}: {
  field: string
  value: string
  onInclude: () => void
  onExclude: () => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'relative z-10 max-w-full cursor-pointer truncate rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 max-sm:after:absolute max-sm:after:-inset-y-3 max-sm:after:-inset-x-1',
          className,
        )}
      >
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel className="truncate font-mono text-xs">
          {field}: {value}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onInclude}>
          <PlusCircleIcon />
          Show only this
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onExclude}>
          <MinusCircleIcon />
          Exclude this
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            navigator.clipboard.writeText(value).then(
              () => toast.success('Copied'),
              () => toast.error('Couldn’t copy'),
            )
          }
        >
          <ClipboardIcon />
          Copy value
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
