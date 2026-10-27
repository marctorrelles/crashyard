import { createFileRoute, getRouteApi, Link, Outlet, useRouterState } from '@tanstack/react-router'
import { pageOf, SettingsNav } from '@/components/settings'
import { PageHeader, Shell, useProjects } from '@/components/shell'

const root = getRouteApi('__root__')

export const Route = createFileRoute('/settings')({ component: SettingsLayout })

// The settings area: the deployment's pages, the project's and the viewer's own, listed at the left edge with the page
// beside them; on a phone the title, then the list as selects, then the page
function SettingsLayout() {
  const { lastProject } = root.useLoaderData()
  const projects = useProjects()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const slug = path.match(/^\/settings\/projects\/([^/]+)/)?.[1]
  const project = slug ? projects.find((p) => p.slug === decodeURIComponent(slug)) : undefined
  const page = pageOf(path) ?? 'Settings'
  return (
    <Shell
      full
      crumbs={[
        <Link to="/settings">Settings</Link>,
        ...(project
          ? [
              <Link to="/settings/projects/$slug/general" params={{ slug: project.slug }}>
                {project.name}
              </Link>,
            ]
          : []),
        page,
      ]}
    >
      <div className="grid gap-5 md:grid-cols-[12rem_minmax(0,1fr)] md:grid-rows-[auto_1fr] md:gap-x-8">
        <div className="min-w-0 *:mb-0 md:col-start-2 md:max-w-4xl">
          <PageHeader title={page}>{project?.name}</PageHeader>
        </div>
        <div className="md:col-start-1 md:row-span-2 md:row-start-1">
          <SettingsNav lastProject={lastProject} />
        </div>
        <div className="grid min-w-0 content-start gap-5 md:col-start-2 md:max-w-4xl">
          <Outlet />
        </div>
      </div>
    </Shell>
  )
}
