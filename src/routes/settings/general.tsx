import { createFileRoute } from '@tanstack/react-router'
import { ReadOnly, SET_IN_WRANGLER, SettingsCard } from '@/components/settings'
import { getInstanceSettings } from '@/fns'

export const Route = createFileRoute('/settings/general')({
  loader: () => getInstanceSettings(),
  head: () => ({ meta: [{ title: 'General · Settings · crashyard' }] }),
  component: General,
})

function General() {
  const { origin, publicUrl } = Route.useLoaderData()
  return (
    <SettingsCard title="Address" description="Where crashyard is reached, and the address alerts link to.">
      <div className="grid gap-4">
        <ReadOnly
          label="Public URL"
          value={publicUrl ?? `Not set. Alerts link to ${origin}, the address this page came from.`}
          note={`PUBLIC_URL. ${SET_IN_WRANGLER}`}
        />
      </div>
    </SettingsCard>
  )
}
