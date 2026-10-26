import { createFileRoute, getRouteApi, Link, Outlet, useRouterState } from '@tanstack/react-router'
import { pageOf, SettingsNav } from '@/components/settings'
import { PageHeader, Shell, useProjects } from '@/components/shell'

const root = getRouteApi('__root__')

export const Route = createFileRoute('/settings')({ component: SettingsLayout })

// The settings area: the deployment's pages, the project's and the viewer's own, listed beside the page
function SettingsLayout() {
  const { lastProject } = root.useLoaderData()
  const projects = useProjects()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const slug = path.match(/^\/settings\/projects\/([^/]+)/)?.[1]
  const project = slug ? projects.find((p) => p.slug === decodeURIComponent(slug)) : undefined
  const page = pageOf(path) ?? 'Settings'
  return (
    <Shell
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
      <PageHeader title={page}>{project?.name}</PageHeader>
      <div className="grid gap-5 md:grid-cols-[12rem_minmax(0,1fr)] md:gap-8">
        <SettingsNav lastProject={lastProject} />
        <div className="grid min-w-0 content-start gap-5">
          <Outlet />
        </div>
      </div>
    </Shell>
  )
}
