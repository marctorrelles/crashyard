import { createFileRoute, notFound, redirect } from '@tanstack/react-router'

// A project's settings pages that moved or were merged into its tabs: their old addresses open the tab, at their section
const MOVED: Record<string, [tab: string, hash?: string]> = {
  keys: ['connect', 'client-keys'],
  'debug-files': ['stack-traces'],
  source: ['stack-traces'],
  limits: ['events'],
  filters: ['events'],
  delete: ['general'],
  grouping: ['issues'],
}

export const Route = createFileRoute('/settings/projects/$slug/$')({
  beforeLoad: ({ params }) => {
    const page = params._splat ?? ''
    if (page === 'status-page') throw redirect({ to: '/monitors/status-pages/$slug', params: { slug: params.slug } })
    const moved = MOVED[page]
    if (!moved) throw notFound()
    throw redirect({
      href: `/settings/projects/${encodeURIComponent(params.slug)}/${moved[0]}${moved[1] ? `#${moved[1]}` : ''}`,
    })
  },
})
