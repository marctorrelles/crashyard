import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/settings/projects/$slug/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/settings/projects/$slug/general', params })
  },
})
