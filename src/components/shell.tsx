// The frame every page sits in: the sidebar (the sections, then each project, the open one with its pages), the bar
// above the page with the sidebar's toggle, and the page's width.
import { getRouteApi, Link, useRouterState } from '@tanstack/react-router'
import { ActivityIcon, BellIcon, BugIcon, LayoutGridIcon, ScrollTextIcon } from 'lucide-react'
import { useId } from 'react'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

const root = getRouteApi('__root__')

export function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/85 px-[max(0.75rem,env(safe-area-inset-left))] pt-[env(safe-area-inset-top)] backdrop-blur">
          <SidebarTrigger className="size-10 md:size-8" />
          <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight md:hidden">
            <Logo />
            crashyard
          </Link>
        </header>
        <main
          className={cn(
            'mx-auto w-full flex-1 px-[max(1rem,env(safe-area-inset-left))] pt-5 pb-[max(2.5rem,env(safe-area-inset-bottom))]',
            wide ? 'max-w-7xl' : 'max-w-5xl',
          )}
        >
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}

const SECTIONS = [
  { to: '/', label: 'Projects', icon: LayoutGridIcon },
  { to: '/issues', label: 'Issues', icon: BugIcon },
  { to: '/logs', label: 'Logs', icon: ScrollTextIcon },
  { to: '/monitors', label: 'Monitors', icon: ActivityIcon },
  { to: '/notifications', label: 'Notifications', icon: BellIcon },
] as const

function AppSidebar() {
  const projects = root.useLoaderData()
  const { setOpenMobile } = useSidebar()
  const { pathname, project } = useRouterState({
    select: (s) => ({
      pathname: s.location.pathname,
      project:
        s.location.pathname.match(/^\/projects\/([^/]+)/)?.[1] ??
        (s.location.pathname === '/issues' ? (s.location.search as { project?: string }).project : undefined),
    }),
  })
  const close = () => setOpenMobile(false)
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip="crashyard">
              <Link to="/" onClick={close} className="font-semibold tracking-tight">
                <span className="-ml-2 flex size-8 shrink-0 items-center justify-center group-data-[collapsible=icon]:ml-0">
                  <Logo />
                </span>
                <span>crashyard</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {SECTIONS.map(({ to, label, icon: Icon }) => (
              <SidebarMenuItem key={to}>
                <SidebarMenuButton
                  asChild
                  tooltip={label}
                  isActive={to === '/' ? pathname === '/' : pathname.startsWith(to) && !project}
                >
                  <Link to={to} onClick={close}>
                    <Icon />
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        {projects.length > 0 && (
          <SidebarGroup className="group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel>Projects</SidebarGroupLabel>
            <SidebarMenu>
              {projects.map((p) => (
                <SidebarMenuItem key={p.id}>
                  <SidebarMenuButton asChild isActive={p.slug === project && pathname === '/issues'}>
                    <Link to="/issues" search={{ project: p.slug }} onClick={close}>
                      <span>{p.name}</span>
                    </Link>
                  </SidebarMenuButton>
                  {p.slug === project && <ProjectPages slug={p.slug} pathname={pathname} onClick={close} />}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}

function ProjectPages({ slug, pathname, onClick }: { slug: string; pathname: string; onClick: () => void }) {
  const pages = [
    { to: '/projects/$slug/releases', label: 'Releases' },
    { to: '/projects/$slug/performance', label: 'Performance' },
    { to: '/projects/$slug/settings', label: 'Settings' },
  ] as const
  return (
    <SidebarMenuSub>
      {pages.map(({ to, label }) => (
        <SidebarMenuSubItem key={to}>
          <SidebarMenuSubButton asChild isActive={pathname.startsWith(to.replace('$slug', slug))}>
            <Link to={to} params={{ slug }} onClick={onClick}>
              {label}
            </Link>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ))}
    </SidebarMenuSub>
  )
}

// The c of crashyard with its upper end cracked off and lifted clear (the large-size drawing is docs/images/logo.svg;
// this one's crack is wider, so it still shows at 20 px)
const RING = 'M20.29,17.59A10 10 0 1 1 20.29,6.41L16.06,9.26A4.9 4.9 0 1 0 16.06,14.74Z'

function Logo() {
  const id = useId()
  return (
    <svg viewBox="0 0 24 24" className="size-5 shrink-0 fill-foreground" aria-hidden="true">
      <clipPath id={`${id}n`}>
        <polygon points="12,12 24,12 24,24 0,24 -6.02,-0.62 0.49,4.9 3.39,5.82 3.89,7.89 5.78,7.98 6.55,9.5 8.28,10.34" />
      </clipPath>
      <clipPath id={`${id}f`}>
        <polygon points="12,12 9.17,9.07 7.44,8.22 6.67,6.71 4.79,6.61 4.28,4.54 1.39,3.62 -6.02,-0.62 -2,-6 24,-6 24,12" />
      </clipPath>
      <path d={RING} clipPath={`url(#${id}n)`} />
      <path d={RING} clipPath={`url(#${id}f)`} transform="translate(.45 -.5)" />
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
