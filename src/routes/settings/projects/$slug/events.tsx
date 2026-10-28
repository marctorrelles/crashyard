import { createFileRoute } from '@tanstack/react-router'
import { Filters } from './-filters'
import { Limits } from './-limits'

export const Route = createFileRoute('/settings/projects/$slug/events')({ component: Events })

// What the project takes in and how long it keeps it: its limits and retention, then what it turns away
function Events() {
  return (
    <>
      <Limits />
      <Filters />
    </>
  )
}
