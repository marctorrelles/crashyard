import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router'
import { ReadOnly, SET_IN_WRANGLER, SettingsCard } from '@/components/settings'
import { getInstanceSettings } from '@/fns'

export const Route = createFileRoute('/settings/general')({
  loader: () => getInstanceSettings(),
  head: () => ({ meta: [{ title: 'General · Settings · crashyard' }] }),
  component: General,
})

const root = getRouteApi('__root__')

function General() {
  const { origin, publicUrl, access } = Route.useLoaderData()
  const { auth } = root.useLoaderData()
  return (
    <>
      <SettingsCard title="Address" description="Where crashyard is reached, and the address alerts link to.">
        <div className="grid gap-4">
          <ReadOnly
            label="Public URL"
            value={publicUrl ?? `Not set. Alerts link to ${origin}, the address this page came from.`}
            note={`PUBLIC_URL. ${SET_IN_WRANGLER}`}
          />
        </div>
      </SettingsCard>
      {auth === 'crashyard' ? (
        <SettingsCard
          title="Sign-in"
          description={
            <>
              People sign in with passkeys, and owners invite them in{' '}
              <Link to="/settings/people" className="font-medium text-foreground underline underline-offset-2">
                People
              </Link>
              .
            </>
          }
        >
          <ReadOnly
            label="How people sign in"
            value="crashyard’s own sign-in"
            note={`AUTH. ${SET_IN_WRANGLER} Set it to access to use Cloudflare Access instead.`}
          />
        </SettingsCard>
      ) : (
        <SettingsCard
          title="Cloudflare Access"
          description="Access signs people in. Without both values, crashyard refuses every dashboard request."
        >
          <div className="grid gap-4 @xl:grid-cols-2">
            <ReadOnly
              label="Team domain"
              value={access.team ?? 'Not set'}
              note={`ACCESS_TEAM_DOMAIN. ${SET_IN_WRANGLER}`}
            />
            <ReadOnly
              label="Audience"
              value={access.audience ? 'Set' : 'Not set'}
              note={`ACCESS_AUD, the application’s audience tag. ${SET_IN_WRANGLER}`}
            />
          </div>
        </SettingsCard>
      )}
    </>
  )
}
