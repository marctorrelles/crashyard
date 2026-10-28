import { createFileRoute } from '@tanstack/react-router'
import { getPush } from '@/fns'
import { DateAndTime } from './-date-and-time'
import { Home } from './-home'
import { Push } from './-push'
import { StackTraces } from './-stack-traces'

export const Route = createFileRoute('/settings/preferences')({
  // The time Date and time shows as an example, the same on the server and in the browser; the viewer's push devices
  loader: async () => ({ now: Date.now(), push: await getPush() }),
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
      <Push />
    </>
  )
}
