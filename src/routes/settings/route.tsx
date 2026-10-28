import { createFileRoute, Link, Outlet, useRouterState } from '@tanstack/react-router'
import { NewProject } from '@/components/new-project'
import { pageOf, SettingsNav, useSettingsProject } from '@/components/settings'
import { PageHeader, Shell, useProjects } from '@/components/shell'

export const Route = createFileRoute('/settings')({ component: SettingsLayout })

// The settings area: the deployment's pages, Projects (and the open project's pages) and the viewer's own, listed at
// the left edge with the page centred beside them; with less room, a phone or a narrow window with the sidebar open,
// the title, then the list as a select, then the page
function SettingsLayout() {
  const projects = useProjects()
  const path = useRouterState({ select: (s) => s.location.pathname.replace(/\/$/, '') })
  const project = useSettingsProject()
  const page = pageOf(path) ?? 'Settings'
  return (
    <Shell
      full
      crumbs={[
        <Link to="/settings">Settings</Link>,
        ...(project
          ? [
              <Link to="/settings/projects">Projects</Link>,
              <Link to="/settings/projects/$slug/general" params={{ slug: project.slug }}>
                {project.name}
              </Link>,
            ]
          : []),
        page,
      ]}
    >
      {/* The frame and the page are containers: the list goes beside the page, and a page's fields side by side, by
          the room they have, which the sidebar's width changes, not the window's */}
      <div className="@container/settings">
        <div className="grid gap-5 @3xl/settings:grid-cols-[12rem_minmax(0,1fr)] @3xl/settings:grid-rows-[auto_1fr] @3xl/settings:gap-x-8">
          <div className="mx-auto w-full max-w-4xl min-w-0 *:mb-0 @3xl/settings:col-start-2">
            <PageHeader
              title={page}
              actions={path === '/settings/projects' && projects.length > 0 && <NewProject variant="outline" />}
            >
              {project?.name}
            </PageHeader>
          </div>
          <div className="@3xl/settings:col-start-1 @3xl/settings:row-span-2 @3xl/settings:row-start-1">
            <SettingsNav />
          </div>
          <div className="@container mx-auto grid w-full max-w-4xl min-w-0 content-start gap-5 @3xl/settings:col-start-2">
            <Outlet />
          </div>
        </div>
      </div>
    </Shell>
  )
}
