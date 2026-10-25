// The frame every page sits in: the bar on top (home, issues, notifications) and the page's width.
import { Link } from '@tanstack/react-router'
import { ActivityIcon, BellIcon, BugIcon, ScrollTextIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur">
        <nav
          className={cn(
            'mx-auto flex h-12 items-center gap-1 px-[max(1rem,env(safe-area-inset-left))]',
            wide ? 'max-w-7xl' : 'max-w-5xl',
          )}
        >
          <Link to="/" className="mr-2 flex items-center gap-2 font-semibold tracking-tight">
            <Logo />
            crashyard
          </Link>
          <NavLink to="/issues" icon={<BugIcon />}>
            Issues
          </NavLink>
          <NavLink to="/logs" icon={<ScrollTextIcon />}>
            Logs
          </NavLink>
          <NavLink to="/monitors" icon={<ActivityIcon />}>
            Monitors
          </NavLink>
          <NavLink to="/notifications" icon={<BellIcon />}>
            Notifications
          </NavLink>
        </nav>
      </header>
      <main
        className={cn(
          'mx-auto w-full flex-1 px-[max(1rem,env(safe-area-inset-left))] pt-5 pb-[max(2.5rem,env(safe-area-inset-bottom))]',
          wide ? 'max-w-7xl' : 'max-w-5xl',
        )}
      >
        {children}
      </main>
    </div>
  )
}

function NavLink({
  to,
  icon,
  children,
}: {
  to: '/issues' | '/logs' | '/monitors' | '/notifications'
  icon: React.ReactNode
  children: string
}) {
  return (
    <Link
      to={to}
      className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground data-[status=active]:text-foreground [&_svg]:size-4"
      aria-label={children}
    >
      {icon}
      <span className="max-sm:hidden">{children}</span>
    </Link>
  )
}

function Logo() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="6" className="fill-foreground" />
      <path
        d="M7 15l3-6 3 4 2-3 2 5"
        className="fill-none stroke-background"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A page's title row: the title, what it's about, and its actions at the end (below it on a phone) */
export function PageHeader({
  title,
  children,
  actions,
}: {
  title: React.ReactNode
  children?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight break-words">{title}</h1>
        {children && <div className="mt-1 text-sm text-muted-foreground">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-muted-foreground">{children}</div>}
    </div>
  )
}
