import { createFileRoute } from '@tanstack/react-router'
import { ReadOnly, SET_IN_WRANGLER, SettingsCard } from '@/components/settings'
import { getInstanceSettings } from '@/fns'

export const Route = createFileRoute('/settings/general')({
  loader: () => getInstanceSettings(),
  head: () => ({ meta: [{ title: 'General · Settings · crashyard' }] }),
  component: General,
})

const DOCS = 'https://github.com/marctorrelles/crashyard/blob/main/docs'

// Where crashyard is reached, its version and its docs
function General() {
  const { origin, publicUrl, version, update } = Route.useLoaderData()
  const link = 'font-medium underline underline-offset-2'
  return (
    <>
      <SettingsCard title="crashyard">
        <div className="grid gap-4 @xl:grid-cols-2">
          <ReadOnly
            label="Public URL"
            value={publicUrl ?? `Not set. Alerts link to ${origin}, the address this page came from.`}
            note={`PUBLIC_URL. ${SET_IN_WRANGLER}`}
          />
          <ReadOnly
            label="Version"
            value={version}
            note={
              update ? (
                <>
                  {update.version} is available.{' '}
                  <a href={update.url} className={link}>
                    See what’s new
                  </a>{' '}
                  or{' '}
                  <a href={`${DOCS}/upgrading.md`} className={link}>
                    how to upgrade
                  </a>
                  .
                </>
              ) : (
                'This is the newest release.'
              )
            }
          />
        </div>
      </SettingsCard>
      <SettingsCard title="Documentation">
        <ul className="grid gap-1.5 text-sm">
          {[
            ['Deploying', 'deploying.md'],
            ['Linking an app', 'linking.md'],
            ['Upgrading', 'upgrading.md'],
            ['The MCP server', 'mcp.md'],
            ['Sentry compatibility', 'sentry-compatibility.md'],
          ].map(([label, file]) => (
            <li key={file}>
              <a href={`${DOCS}/${file}`} className={link}>
                {label}
              </a>
            </li>
          ))}
        </ul>
      </SettingsCard>
    </>
  )
}
