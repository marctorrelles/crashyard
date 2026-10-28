import { createFileRoute, notFound, redirect } from '@tanstack/react-router'

// Settings pages that moved or were merged into others: their old addresses open where they went
const MOVED: Record<string, string> = {
  email: '/notifications',
  data: '/settings/privacy',
  defaults: '/settings/projects',
  about: '/settings/general',
  'sign-in': '/settings/account',
  'date-and-time': '/settings/preferences',
  'stack-traces': '/settings/preferences',
  home: '/settings/preferences',
}

export const Route = createFileRoute('/settings/$')({
  beforeLoad: ({ params }) => {
    const to = MOVED[params._splat ?? '']
    if (!to) throw notFound()
    throw redirect({ href: to })
  },
})
