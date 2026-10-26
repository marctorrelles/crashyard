import { createFileRoute, notFound, Outlet } from '@tanstack/react-router'
import { getProjectSettings } from '@/fns'

// A project's settings pages share its settings, loaded once here
export const Route = createFileRoute('/settings/projects/$slug')({
  loader: async ({ params }) => {
    const data = await getProjectSettings({ data: { slug: params.slug } })
    if (!data) throw notFound()
    return data
  },
  head: ({ loaderData }) => ({ meta: [{ title: `Settings · ${loaderData?.project.name} · crashyard` }] }),
  component: Outlet,
})
