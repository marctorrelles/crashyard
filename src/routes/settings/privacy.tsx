import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Hint, SaveButton, SettingsCard, useSave } from '@/components/settings'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { getInstanceSettings, saveScrubFields } from '@/fns'

export const Route = createFileRoute('/settings/privacy')({
  loader: () => getInstanceSettings(),
  head: () => ({ meta: [{ title: 'Privacy · Settings · crashyard' }] }),
  component: Privacy,
})

// What's scrubbed from what apps send before it's stored
function Privacy() {
  const { scrubFields } = Route.useLoaderData()
  const { save, saving } = useSave()
  const [text, setText] = useState(scrubFields.join('\n'))
  return (
    <>
      <SettingsCard
        title="Always scrubbed"
        description="Before anything is stored, values under names like password, secret, token, auth, cookie or session become [Filtered]. Emails, card numbers and bearer tokens in any text are masked. User IDs are kept only as a hash."
      />
      <SettingsCard
        title="Extra fields to scrub"
        description="Your own names, for data only your apps send. Any field whose name contains one is filtered, in any case."
      >
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void save(() => saveScrubFields({ data: { fields: text.split(/[\n,]/) } }))
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="fields">Field names, one a line</Label>
            <Textarea
              id="fields"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              placeholder={'iban\npin\nphone'}
              className="font-mono"
            />
            <Hint>New events use the list within a minute. Events already stored keep what they have.</Hint>
          </div>
          <div>
            <SaveButton saving={saving} />
          </div>
        </form>
      </SettingsCard>
    </>
  )
}
