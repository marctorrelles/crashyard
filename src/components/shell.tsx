// The frame every page sits in. The sidebar, in the root layout so it stays put between pages: the project filter on
// top, the same pages under it whichever project is picked, and Settings and who's signed in with Sign out at the foot. `Shell` is a page's
// width; `PageHeader` and `Empty` are what pages are made of.
import { getRouteApi, Link, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  IconActivity,
  IconArrowUpRight,
  IconCircleArrowUp,
  IconBell,
  IconBroadcast,
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
  IconX,
} from '@tabler/icons-react'
import { Fragment, useEffect, useState, useSyncExternalStore } from 'react'
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
import { Button } from '@/components/ui/button'
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
import { NewVersion } from '@/components/new-version'
import { PushPrompt } from '@/components/push'
import { UpdateDialog } from '@/components/update'
import { cn } from '@/lib/utils'

const root = getRouteApi('__root__')

/** Every project, from the root's loader */
export const useProjects = () => root.useLoaderData().projects

/** The viewer's preferences (Settings, You), from the root's loader */
export const usePreferences = () => root.useLoaderData().preferences

/** The project the sidebar is on, and the cookie that keeps it for pages that aren't any project's */
const PROJECT_COOKIE = 'crashyard_project'

export function Layout({ children }: { children: React.ReactNode }) {
  const { sidebarOpen, demo } = root.useLoaderData()
  return (
    <SidebarProvider defaultOpen={sidebarOpen}>
      <AppSidebar />
      <PushPrompt />
      <NewVersion />
      <SidebarInset className="min-w-0">
        {demo && <DemoBanner />}
        {children}
      </SidebarInset>
    </SidebarProvider>
  )
}

// Where "Deploy your own" goes, on the demo's pages (src/demo.ts): the README's Get started
export const DEPLOY_YOUR_OWN = 'https://github.com/marctorrelles/crashyard#get-started'
const DEMO_BANNER = 'crashyard.demo-banner-closed'

/** The demo's slim bar over every page, until closed for this browser session (sessionStorage; the server renders it
 *  open, as it can't know) */
let bannerClosedHere = false
const closedBanner = () => {
  try {
    return bannerClosedHere || !!sessionStorage.getItem(DEMO_BANNER)
  } catch {
    // ponytail: no storage (blocked) shows it again on each page load
    return bannerClosedHere
  }
}
const bannerListeners = new Set<() => void>()
function DemoBanner() {
  const closed = useSyncExternalStore(
    (listener) => (bannerListeners.add(listener), () => bannerListeners.delete(listener)),
    closedBanner,
    () => false,
  )
  if (closed) return null
  const close = () => {
    bannerClosedHere = true
    try {
      sessionStorage.setItem(DEMO_BANNER, '1')
    } catch {
      // as above
    }
    bannerListeners.forEach((l) => l())
  }
  return (
    <div className="flex items-center gap-2 border-b bg-primary/10 py-1 pr-[max(0.25rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] text-sm">
      <p className="min-w-0 flex-1 py-1.5">
        This is a demo with made-up apps. Deploy your own crashyard to send yours.{' '}
        <a
          href={DEPLOY_YOUR_OWN}
          className="inline-flex items-center gap-0.5 font-medium whitespace-nowrap underline underline-offset-2"
        >
          Deploy your own
          <IconArrowUpRight className="size-3.5" />
        </a>
      </p>
      <Button variant="ghost" size="icon-sm" className="shrink-0 max-sm:size-10" aria-label="Close" onClick={close}>
        <IconX />
      </Button>
    </div>
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

const SignedIn = ({ name, email, demo }: { name: string | null; email: string | null; demo: boolean }) => (
  <span className="grid min-w-0 leading-tight">
    <span>{demo ? 'Leave demo' : 'Sign out'}</span>
    <span className="truncate text-xs text-sidebar-foreground/70" title={email ?? undefined}>
      {name ?? email}
    </span>
  </span>
)

function AppSidebar() {
  const { viewer, name, update, demo } = root.useLoaderData()
  const { page, projects, project, keep } = useCurrentProject()
  const { setOpenMobile } = useSidebar()
  const close = () => setOpenMobile(false)
  const [updating, setUpdating] = useState(false)
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
            <Item label="Status pages" icon={IconBroadcast} active={at('/status-pages')}>
              {(c) => (
                <Link to="/status-pages" onClick={close}>
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
          {update && (
            <SidebarMenuItem>
              {/* Tinted, unlike the pages above, whose hover is grey: it's news, not a place */}
              <SidebarMenuButton
                tooltip={`crashyard ${update.version} is available`}
                className="h-auto bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary active:bg-primary/25 active:text-primary"
                onClick={() => setUpdating(true)}
              >
                <IconCircleArrowUp />
                <span className="grid min-w-0 leading-tight">
                  <span className="font-medium">Update available</span>
                  <span className="truncate text-xs text-sidebar-foreground/70">
                    {update.current} → {update.version}
                  </span>
                </span>
              </SidebarMenuButton>
              <UpdateDialog open={updating} onOpenChange={setUpdating} />
            </SidebarMenuItem>
          )}
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
              <SidebarMenuButton type="submit" tooltip={demo ? 'Leave demo' : 'Sign out'} className="h-auto">
                <IconLogout />
                <SignedIn name={name} email={demo ? null : viewer} demo={demo} />
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
  const loading = usePageLoading()
  // Set once the loader's first round starts, cleared at the end of the round in which the page came: a round always
  // finishes, back to the whole mark, so the swap to the logo is seamless
  const [drawing, setDrawing] = useState(false)
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
                {loading || drawing ? (
                  <Loader
                    className="size-8! shrink-0 text-sidebar-foreground group-data-[collapsible=icon]:size-5!"
                    onStart={() => setDrawing(true)}
                    onRound={() => !loading && setDrawing(false)}
                  />
                ) : (
                  <Logo />
                )}
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
// the mouth's two lines (the tiled drawings are docs/images/logo.svg and src/favicon.svg). MARK is its outline; LINE
// its centreline, which stroked 2 wide with butt caps and miter joins covers exactly the outline, so the loader draws
// the same mark. 32 px, as tall as the name and project beside it, 20 folded to icons, over the menu button's 16 px
// for every svg; in the sidebar's colour, which isn't always the page's
const MARK =
  'M19.73 5.04A10.4 10.4 0 1 0 19.73 18.96L15.94 15.55A5.3 5.3 0 1 1 14.31 7.23L13.41 8.04A4.2 4.2 0 1 0 15.12 14.81L13.63 13.47A2.2 2.2 0 1 1 13.63 10.53L17.42 7.12A7.3 7.3 0 1 0 15.88 18.18L16.72 18.95A8.4 8.4 0 1 1 18.24 6.38Z'
const LINE =
  'M18.99 5.71A9.4 9.4 0 1 0 18.28 19L15.95 16.91A6.3 6.3 0 1 1 15.95 7.09L13.59 9.22A3.2 3.2 0 1 0 14.38 14.14'

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

/**
 * The sidebar's logo while a page loads: from the whole mark it takes itself away from its start, then draws itself
 * back (`.cy-draw` in styles.css). `onRound` at the end of each round, when it's whole again
 */
function Loader({ className, onStart, onRound }: { className: string; onStart: () => void; onRound: () => void }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        d={LINE}
        pathLength={1}
        className="cy-draw"
        onAnimationStart={onStart}
        onAnimationIteration={onRound}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="butt"
        strokeLinejoin="miter"
      />
    </svg>
  )
}

// A page on its way: true once the router has been loading for 300 ms, so a quick one never flickers
function usePageLoading() {
  const loading = useRouterState({ select: (s) => s.isLoading })
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!loading) return
    const timer = setTimeout(() => setShown(true), 300)
    return () => {
      clearTimeout(timer)
      setShown(false)
    }
  }, [loading])
  return loading && shown
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
