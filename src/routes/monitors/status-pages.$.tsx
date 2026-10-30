import { createFileRoute, redirect } from '@tanstack/react-router'

// Status pages moved out of Monitors to their own section: the old addresses open the same page there
export const Route = createFileRoute('/monitors/status-pages/$')({
  beforeLoad: ({ params }) => {
    const slug = params._splat?.replace(/\/$/, '')
    throw slug ? redirect({ to: '/status-pages/$slug', params: { slug } }) : redirect({ to: '/status-pages' })
  },
})
