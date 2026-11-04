import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { ago } from '@/components/bits'
import { Hint, SettingsCard } from '@/components/settings'
import { Button } from '@/components/ui/button'
import { UpdateDialog } from '@/components/update'
import { checkForUpdate, getInstanceSettings } from '@/fns'

export const Route = createFileRoute('/settings/general')({
  loader: () => getInstanceSettings(),
  head: () => ({ meta: [{ title: 'General · Settings · crashyard' }] }),
  component: General,
})

const root = getRouteApi('__root__')
const DOCS = 'https://github.com/marctorrelles/crashyard/blob/main/docs'
const link = 'font-medium underline underline-offset-2'

// The address crashyard links to, its version and updates, and its docs
function General() {
  const { origin, publicUrl } = Route.useLoaderData()
  return (
    <>
      <SettingsCard title="Public URL" description="The address alerts, invites and the MCP server link to.">
        <div className="grid gap-1">
          <p className={publicUrl ? 'font-mono text-sm break-all' : 'text-sm'}>{publicUrl ?? 'Not set'}</p>
          <Hint>
            {publicUrl ? '' : `Links use ${origin}, the address this page came from. `}
            Set as PUBLIC_URL in wrangler.local.json. Change it there, then deploy again.
          </Hint>
        </div>
      </SettingsCard>
      <Updates />
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

// The version and whether a newer one is out (GitHub asked once a day, or now), then, for owners, automatic updates;
// installing and setting them up happen in UpdateDialog
function Updates() {
  const { version, update, checkedAt, autoUpdates, now } = Route.useLoaderData()
  const owner = root.useLoaderData().role === 'owner'
  const router = useRouter()
  const [dialog, setDialog] = useState(false)
  const [checking, setChecking] = useState(false)
  const checkNow = async () => {
    setChecking(true)
    try {
      await checkForUpdate()
      await router.invalidate()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That didn’t work. Try again.')
    } finally {
      setChecking(false)
    }
  }
  const row = 'flex items-center justify-between gap-3'
  return (
    <SettingsCard title="Updates">
      <div className="grid gap-4">
        <div className={row}>
          <div className="grid min-w-0 gap-1">
            <p className="text-sm font-medium">crashyard {version}</p>
            <Hint>
              {update ? (
                <>
                  {update.version} is available.{' '}
                  <a href={update.url} target="_blank" rel="noreferrer" className={link}>
                    See what’s new
                  </a>
                </>
              ) : checkedAt ? (
                `Up to date. Checked ${ago(checkedAt, now)}.`
              ) : (
                'Couldn’t reach GitHub to check for a newer release.'
              )}
            </Hint>
          </div>
          {owner &&
            (update ? (
              <Button size="sm" className="shrink-0" onClick={() => setDialog(true)}>
                Update to {update.version}
              </Button>
            ) : (
              <Button size="sm" className="shrink-0" variant="outline" disabled={checking} onClick={checkNow}>
                {checking ? 'Checking…' : 'Check now'}
              </Button>
            ))}
        </div>
        {owner && (
          <div className={`${row} border-t pt-4`}>
            <div className="grid min-w-0 gap-1">
              <p className="text-sm font-medium">Automatic updates</p>
              <Hint>
                {autoUpdates
                  ? 'On. A new release installs every day at 03:40 UTC.'
                  : 'Off. With a Cloudflare API token, crashyard installs new releases on its own.'}
              </Hint>
            </div>
            <Button size="sm" className="shrink-0" variant="outline" onClick={() => setDialog(true)}>
              {autoUpdates ? 'Manage' : 'Set up'}
            </Button>
          </div>
        )}
      </div>
      <UpdateDialog open={dialog} onOpenChange={setDialog} />
    </SettingsCard>
  )
}
