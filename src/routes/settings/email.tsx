import { createFileRoute } from '@tanstack/react-router'
import { IconMail } from '@tabler/icons-react'
import { useState } from 'react'
import { ReadOnly, SET_IN_WRANGLER, SettingsCard, useSave } from '@/components/settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { sendTestEmail, getInstanceSettings } from '@/fns'

export const Route = createFileRoute('/settings/email')({
  loader: () => getInstanceSettings(),
  head: () => ({ meta: [{ title: 'Email · Settings · crashyard' }] }),
  component: Email,
})

function Email() {
  const { emailFrom } = Route.useLoaderData()
  const { save, saving } = useSave()
  const [to, setTo] = useState('')
  return (
    <>
      <SettingsCard
        title="Sender"
        description="Email channels send from this address through Cloudflare Email Routing."
      >
        <ReadOnly
          label="From"
          value={emailFrom ?? 'Not set. Email channels stay off until it is.'}
          note={`EMAIL_FROM. ${SET_IN_WRANGLER}`}
        />
      </SettingsCard>
      <SettingsCard
        title="Send test email"
        description="Email Routing only delivers to verified destination addresses. Add one there first."
      >
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void save(() => sendTestEmail({ data: { to } }), `Test email sent to ${to}`)
          }}
        >
          <Input
            className="max-w-xs"
            type="email"
            required
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="you@example.com"
            aria-label="Send to"
          />
          <Button type="submit" variant="outline" disabled={saving || !emailFrom} className="max-sm:h-10">
            <IconMail data-icon="inline-start" />
            Send test email
          </Button>
        </form>
      </SettingsCard>
    </>
  )
}
