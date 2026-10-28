// The frame every page sits in. The sidebar, in the root layout so it stays put between pages: the project filter on
// top, the same pages under it whichever project is picked, and Settings and who's signed in with Sign out at the foot. `Shell` is a page's
// width; `PageHeader` and `Empty` are what pages are made of.
import { getRouteApi, Link, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  IconActivity,
  IconBell,
  IconBug,
  IconCheck,
  IconCompass,
  IconGauge,
  IconHome,
  IconLayoutDashboard,
  IconLayoutGrid,
  IconLogout,
  IconLogs,
  IconSelector,
  IconSettings,
  IconTag,
} from '@tabler/icons-react'
import { Fragment, useEffect, useState } from 'react'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Empty as EmptyState,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Separator } from '@/components/ui/separator'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

const root = getRouteApi('__root__')

/** Every project, from the root's loader */
export const useProjects = () => root.useLoaderData().projects

/** The viewer's preferences (Settings, You), from the root's loader */
export const usePreferences = () => root.useLoaderData().preferences

/** The project the sidebar is on, and the cookie that keeps it for pages that aren't any project's */
const PROJECT_COOKIE = 'crashyard_project'

export function Layout({ children }: { children: React.ReactNode }) {
  const { sidebarOpen } = root.useLoaderData()
  return (
    <SidebarProvider defaultOpen={sidebarOpen}>
      <AppSidebar />
      <SidebarInset className="min-w-0">{children}</SidebarInset>
    </SidebarProvider>
  )
}

/**
 * A page: the top bar with the sidebar's toggle and the page's breadcrumbs, then its content. `crumbs` run from the
 * section down to the page: links (each a `<Link>`) and last the page itself as text
 */
export function Shell({
  children,
  crumbs,
  wide,
  full,
}: {
  children: React.ReactNode
  crumbs: React.ReactNode[]
  wide?: boolean
  full?: boolean // the whole width, from the sidebar's edge: settings, with its list on the left
}) {
  return (
    <>
      <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/85 px-[max(0.75rem,env(safe-area-inset-left))] pt-[env(safe-area-inset-top)] backdrop-blur">
        <SidebarTrigger className="size-10 md:size-8" />
        <Separator orientation="vertical" className="mr-1 data-vertical:h-4 data-vertical:self-center" />
        <Breadcrumb className="min-w-0">
          <BreadcrumbList className="flex-nowrap">
            {crumbs.map((crumb, i) => {
              const last = i === crumbs.length - 1
              // A phone keeps the page and the one above it
              const hidden = i < crumbs.length - 2 && 'max-md:hidden'
              return (
                <Fragment key={i}>
                  {i > 0 && <BreadcrumbSeparator className={cn(i < crumbs.length - 1 && 'max-md:hidden')} />}
                  <BreadcrumbItem className={cn('min-w-0', hidden, !last && 'shrink-0')}>
                    {last ? (
                      <BreadcrumbPage className="truncate">{crumb}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild>{crumb}</BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              )
            })}
          </BreadcrumbList>
        </Breadcrumb>
      </header>
      <main
        className={cn(
          'w-full flex-1 px-[max(1rem,env(safe-area-inset-left))] pt-5 pb-[max(2.5rem,env(safe-area-inset-bottom))]',
          !full && (wide ? 'mx-auto max-w-7xl' : 'mx-auto max-w-5xl'),
        )}
      >
        {children}
      </main>
    </>
  )
}

type Page = { path: string; search: Record<string, unknown>; issueProject?: string }

// The pages that list across projects and narrow to one with ?project= (a dashboard too, below)
const LISTS = ['/', '/dashboards', '/issues', '/explore', '/releases', '/performance', '/logs'] as const
type List = (typeof LISTS)[number]
const isList = (path: string): path is List => (LISTS as readonly string[]).includes(path)
// A dashboard's id, when the page is one
const dashboardOf = (path: string) => path.match(/^\/dashboards\/([^/]+)$/)?.[1]

/** The project a page is of: a slug, null for every project's, undefined for a page that's no project's */
function projectOf({ path, search, issueProject }: Page) {
  const slug = path.match(/^\/(?:settings\/)?projects\/([^/]+)/)?.[1]
  if (slug) return decodeURIComponent(slug)
  if (isList(path) || dashboardOf(path)) return typeof search.project === 'string' ? search.project : null
  return issueProject
}

function useCurrentProject() {
  const { projects, lastProject } = root.useLoaderData()
  const page = useRouterState({
    select: (s): Page => ({
      path: s.location.pathname,
      search: s.location.search,
      issueProject: (
        s.matches.find((m) => m.routeId === '/issues/$issueId')?.loaderData as
          { issue?: { project: string } } | undefined
      )?.issue?.project,
    }),
  })
  const shown = projectOf(page)
  // Pages of no project's (monitors, notifications) keep the one picked last
  const [kept, setKept] = useState(lastProject)
  if (shown !== undefined && shown !== kept) setKept(shown)
  useEffect(() => {
    document.cookie = kept
      ? `${PROJECT_COOKIE}=${encodeURIComponent(kept)}; path=/; max-age=31536000; samesite=lax`
      : `${PROJECT_COOKIE}=; path=/; max-age=0`
  }, [kept])
  return { page, projects, project: projects.find((p) => p.slug === kept), keep: setKept }
}

const SignedIn = ({ name, email }: { name: string | null; email: string | null }) => (
  <span className="grid min-w-0 leading-tight">
    <span>Sign out</span>
    <span className="truncate text-xs text-sidebar-foreground/70" title={email ?? undefined}>
      {name ?? email}
    </span>
  </span>
)

function AppSidebar() {
  const { viewer, name } = root.useLoaderData()
  const { page, projects, project, keep } = useCurrentProject()
  const { setOpenMobile } = useSidebar()
  const close = () => setOpenMobile(false)
  const search = { project: project?.slug }
  const at = (...paths: string[]) => paths.some((p) => page.path === p || page.path.startsWith(`${p}/`))
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <ProjectSwitcher projects={projects} current={project} page={page} keep={keep} onPick={close} />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <Item label="Overview" icon={IconHome} active={page.path === '/'}>
              {(c) => (
                <Link to="/" search={search} onClick={close}>
                  {c}
                </Link>
              )}
            </Item>
            <Item label="Dashboards" icon={IconLayoutDashboard} active={at('/dashboards')}>
              {(c) => (
                <Link to="/dashboards" search={search} onClick={close}>
                  {c}
                </Link>
              )}
            </Item>
            <Item label="Issues" icon={IconBug} active={at('/issues')}>
              {(c) => (
                <Link to="/issues" search={search} onClick={close}>
                  {c}
                </Link>
              )}
            </Item>
            <Item label="Explore" icon={IconCompass} active={at('/explore')}>
              {(c) => (
                <Link to="/explore" search={search} onClick={close}>
                  {c}
                </Link>
              )}
            </Item>
            <Item
              label="Releases"
              icon={IconTag}
              active={at('/releases') || /^\/projects\/[^/]+\/releases/.test(page.path)}
            >
              {(c) => (
                <Link to="/releases" search={search} onClick={close}>
                  {c}
                </Link>
              )}
            </Item>
            <Item
              label="Performance"
              icon={IconGauge}
              active={at('/performance') || /^\/projects\/[^/]+\/performance/.test(page.path)}
            >
              {(c) => (
                <Link to="/performance" search={search} onClick={close}>
                  {c}
                </Link>
              )}
            </Item>
            <Item label="Logs" icon={IconLogs} active={at('/logs')}>
              {(c) => (
                <Link to="/logs" search={search} onClick={close}>
                  {c}
                </Link>
              )}
            </Item>
            <Item label="Monitors" icon={IconActivity} active={at('/monitors')}>
              {(c) => (
                <Link to="/monitors" onClick={close}>
                  {c}
                </Link>
              )}
            </Item>
            <Item label="Notifications" icon={IconBell} active={at('/notifications')}>
              {(c) => (
                <Link to="/notifications" onClick={close}>
                  {c}
                </Link>
              )}
            </Item>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <Item label="Settings" icon={IconSettings} active={at('/settings')}>
            {(c) => (
              <Link to="/settings" onClick={close}>
                {c}
              </Link>
            )}
          </Item>
          <SidebarMenuItem>
            {/* Ends this session only: Settings, Account signs out other devices */}
            <form method="post" action="/auth/signout">
              <SidebarMenuButton type="submit" tooltip="Sign out" className="h-auto">
                <IconLogout />
                <SignedIn name={name} email={viewer} />
              </SidebarMenuButton>
            </form>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

/** One page in the sidebar: `children` wraps its icon and label in the page's link */
function Item({
  label,
  icon: Icon,
  active,
  children,
}: {
  label: string
  icon: React.ComponentType
  active: boolean
  children: (content: React.ReactNode) => React.ReactNode
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip={label} isActive={active}>
        {children(
          <>
            <Icon />
            <span>{label}</span>
          </>,
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

type Project = ReturnType<typeof useProjects>[number]

/** The project filter: the page stays, showing the project picked (or every one); its settings are here too */
function ProjectSwitcher({
  projects,
  current,
  page,
  keep,
  onPick,
}: {
  projects: Project[]
  current?: Project
  page: Page
  keep: (slug: string | null) => void
  onPick: () => void
}) {
  const navigate = useNavigate()
  const pick = (slug?: string) => {
    onPick()
    keep(slug ?? null)
    const search = { project: slug }
    const sub = page.path.match(/^\/projects\/[^/]+\/(releases|performance)/)?.[1]
    // A project's settings page stays, for the project picked; every project's goes to the list of projects
    const settingsPage = page.path.match(/^\/settings\/projects\/[^/]+\/([^/]+)/)?.[1]
    const dashboardId = dashboardOf(page.path)
    if (isList(page.path)) void navigate({ to: page.path, search })
    // A dashboard stays, with its range, narrowed to the project
    else if (dashboardId)
      void navigate({
        to: '/dashboards/$dashboardId',
        params: { dashboardId },
        search: (s) => ({ ...s, project: slug }),
      })
    else if (settingsPage)
      void navigate({ to: slug ? `/settings/projects/${slug}/${settingsPage}` : '/settings/projects' })
    else if (sub) void navigate({ to: `/${sub}`, search })
    else if (page.path.startsWith('/issues/')) void navigate({ to: '/issues', search })
  }
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" tooltip="Switch project">
              <span className="flex size-8 shrink-0 items-center justify-center">
                <Logo />
              </span>
              <span className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="font-semibold tracking-tight">crashyard</span>
                <span className="truncate text-xs text-sidebar-foreground/70">{current?.name ?? 'All projects'}</span>
              </span>
              <IconSelector className="ml-auto text-sidebar-foreground/70" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
            <DropdownMenuItem onSelect={() => pick()}>
              <IconLayoutGrid />
              All projects
              {!current && <IconCheck className="ml-auto" />}
            </DropdownMenuItem>
            {projects.length > 0 && <DropdownMenuSeparator />}
            {projects.length > 0 && <DropdownMenuLabel>Projects</DropdownMenuLabel>}
            {projects.map((p) => (
              <DropdownMenuItem key={p.id} onSelect={() => pick(p.slug)}>
                <span className="truncate">{p.name}</span>
                {p.slug === current?.slug && <IconCheck className="ml-auto" />}
              </DropdownMenuItem>
            ))}
            {current && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/settings/projects/$slug/general" params={{ slug: current.slug }} onClick={onPick}>
                    <IconSettings />
                    {current.name} settings
                  </Link>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

// The c of crashyard: one band drawn round three times, folding back at the mouth, every end and fold cut square on
// the mouth's two lines (the tiled drawings are docs/images/logo.svg and src/favicon.svg). 32 px, as tall as the name
// and project beside it, 20 folded to icons, over the menu button's 16 px for every svg; in the sidebar's colour,
// which isn't always the page's
const MARK =
  'M19.73 5.04A10.4 10.4 0 1 0 19.73 18.96L15.94 15.55A5.3 5.3 0 1 1 14.31 7.23L13.41 8.04A4.2 4.2 0 1 0 15.12 14.81L13.63 13.47A2.2 2.2 0 1 1 13.63 10.53L17.42 7.12A7.3 7.3 0 1 0 15.88 18.18L16.72 18.95A8.4 8.4 0 1 1 18.24 6.38Z'

/** crashyard's mark, the sidebar's size and colour unless told otherwise */
export function Logo({
  className = 'size-8! shrink-0 fill-sidebar-foreground group-data-[collapsible=icon]:size-5!',
}: {
  className?: string
}) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d={MARK} />
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

/** Nothing to show yet: an icon, what's missing, a line on how it fills, and what to do about it */
export function Empty({
  icon: Icon,
  title,
  children,
  action,
  compact,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  children?: React.ReactNode
  action?: React.ReactNode
  compact?: boolean // inside a section, not a whole page
}) {
  return (
    <EmptyState className={cn('border border-dashed', compact ? 'p-6 md:p-6' : 'py-12')}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {children && <EmptyDescription>{children}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </EmptyState>
  )
}
