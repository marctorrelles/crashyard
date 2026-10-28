import { createFileRoute } from '@tanstack/react-router'
import { DateAndTime } from './-date-and-time'
import { Home } from './-home'
import { StackTraces } from './-stack-traces'

export const Route = createFileRoute('/settings/preferences')({
  // The time Date and time shows as an example, the same on the server and in the browser
  loader: () => ({ now: Date.now() }),
  head: () => ({ meta: [{ title: 'Preferences · Settings · crashyard' }] }),
  component: PreferencesPage,
})

// How crashyard reads for you: time, stack traces and what opens first
function PreferencesPage() {
  return (
    <>
      <DateAndTime />
      <StackTraces />
      <Home />
    </>
  )
}
