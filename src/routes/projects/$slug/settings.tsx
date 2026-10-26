import { createFileRoute, redirect } from '@tanstack/react-router'

// Where a project's settings were: their own area now
export const Route = createFileRoute('/projects/$slug/settings')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/settings/projects/$slug/general', params })
  },
})
