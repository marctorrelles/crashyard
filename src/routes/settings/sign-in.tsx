import { createFileRoute } from '@tanstack/react-router'
import { IconDeviceDesktop, IconDeviceMobile, IconFingerprint, IconPencil, IconTrash } from '@tabler/icons-react'
import { useState } from 'react'
import { Ago } from '@/components/bits'
import { SettingsCard, useSave } from '@/components/settings'
import { createPasskey, RecoveryCodes } from '@/components/sign-in'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { deviceName, RECOVERY_CODES } from '@/data/people'
import { getSignIn, makeRecoveryCodes, removePasskey, renamePasskey, signOutSession } from '@/fns'

export const Route = createFileRoute('/settings/sign-in')({
  loader: () => getSignIn(),
  head: () => ({ meta: [{ title: 'Sign-in · Settings · crashyard' }] }),
  component: SignInSettings,
})

function SignInSettings() {
  const data = Route.useLoaderData()
  if (data.auth === 'access') return <AccessSignIn canClaim={data.canClaim} email={data.viewer} />
  return (
    <>
      <Passkeys />
      <Recovery />
      <Sessions />
    </>
  )
}

// With Access in front: who it let in, and while crashyard has no one yet, the first passkey for the move over
function AccessSignIn({ canClaim, email }: { canClaim: boolean; email: string }) {
  const { save, saving } = useSave()
  const [codes, setCodes] = useState<string[]>()
  if (codes)
    return (
      <SettingsCard
        title="Save your recovery codes"
        description="If you ever lose your passkeys, sign in with your email and one of these. Each works once, and they won’t be shown again."
      >
        <div className="max-w-sm">
          <RecoveryCodes codes={codes} />
        </div>
      </SettingsCard>
    )
  return (
    <SettingsCard
      title="Cloudflare Access"
      description={`You’re signed in as ${email} through Cloudflare Access. Its policy decides who can open crashyard.`}
    >
      {canClaim && (
        <form
          className="grid gap-3 border-t pt-4 @xl:grid-cols-[1fr_auto] @xl:items-end"
          onSubmit={(e) => {
            e.preventDefault()
            const name = new FormData(e.currentTarget).get('name')
            void save(async () => {
              setCodes((await createPasskey<{ codes: string[] }>('claim', { name })).codes)
            }, 'Passkey created. You’re the owner.')
          }}
        >
          <div className="grid gap-2 @xl:col-span-2">
            <p className="text-sm">
              Moving to crashyard’s own sign-in? Create your passkey first. You become its owner, and once AUTH is set
              to crashyard you sign in with it.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="claim-name">Your name</Label>
            <Input id="claim-name" name="name" required maxLength={80} autoComplete="name" />
          </div>
          <Button type="submit" disabled={saving} className="max-sm:h-10">
            <IconFingerprint data-icon="inline-start" />
            Create passkey
          </Button>
        </form>
      )}
    </SettingsCard>
  )
}

function Passkeys() {
  const { passkeys, now } = Route.useLoaderData()
  const { save, saving } = useSave()
  const [renaming, setRenaming] = useState<string>()
  return (
    <SettingsCard
      title="Passkeys"
      description="Sign in with any of these. Add one on each device you use, so losing one doesn’t lock you out."
    >
      <div className="grid gap-4">
        <ul className="divide-y rounded-xl border text-sm">
          {passkeys.map((p) => (
            <li key={p.id} className="flex min-h-14 items-center gap-3 px-3 py-2">
              <IconFingerprint className="size-5 shrink-0 text-muted-foreground" />
              {renaming === p.id ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const name = String(new FormData(e.currentTarget).get('name'))
                    void save(() => renamePasskey({ data: { id: p.id, name } }), 'Passkey renamed').then(
                      (ok) => ok && setRenaming(undefined),
                    )
                  }}
                >
                  <Input
                    name="name"
                    defaultValue={p.name}
                    aria-label="Passkey name"
                    maxLength={60}

                    className="min-w-0 flex-1"
                  />
                  <Button type="submit" size="sm" disabled={saving} className="max-sm:h-10">
                    Save
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setRenaming(undefined)}
                    className="max-sm:h-10"
                  >
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{p.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Added <Ago at={p.created_at} now={now} />
                      {p.last_used_at ? (
                        <>
                          {' '}
                          · used <Ago at={p.last_used_at} now={now} />
                        </>
                      ) : (
                        ' · never used'
                      )}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="max-sm:size-10"
                    aria-label={`Rename ${p.name}`}
                    onClick={() => setRenaming(p.id)}
                  >
                    <IconPencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="max-sm:size-10"
                    aria-label={`Remove ${p.name}`}
                    onClick={() => {
                      if (!confirm(`Remove ${p.name}? You won’t be able to sign in with it anymore.`)) return
                      void save(() => removePasskey({ data: { id: p.id } }), `${p.name} removed`)
                    }}
                  >
                    <IconTrash />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
        <div>
          <Button
            variant="outline"
            disabled={saving}
            className="max-sm:h-10"
            onClick={() =>
              void save(async () => {
                const { name } = await createPasskey<{ name: string }>('passkeys')
                return name
              }, 'Passkey added')
            }
          >
            <IconFingerprint data-icon="inline-start" />
            Add passkey
          </Button>
        </div>
      </div>
    </SettingsCard>
  )
}

function Recovery() {
  const { codesLeft } = Route.useLoaderData()
  const { save, saving } = useSave()
  const [codes, setCodes] = useState<string[]>()
  return (
    <SettingsCard
      title="Recovery codes"
      description="If you lose every passkey, sign in with your email and one of these. Each works once."
    >
      {codes ? (
        <div className="grid max-w-sm gap-3">
          <p className="text-sm">Save these now. They won’t be shown again, and your old codes no longer work.</p>
          <RecoveryCodes codes={codes} />
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className={codesLeft <= 2 ? 'text-sm font-medium text-destructive' : 'text-sm'}>
            {codesLeft === 0 ? 'You have no recovery codes left.' : `${codesLeft} of ${RECOVERY_CODES} codes left.`}
          </p>
          <Button
            variant="outline"
            disabled={saving}
            className="max-sm:h-10"
            onClick={() => {
              if (codesLeft && !confirm('Make new recovery codes? The ones you have stop working.')) return
              void save(async () => setCodes(await makeRecoveryCodes()), 'New recovery codes made')
            }}
          >
            Make new codes
          </Button>
        </div>
      )}
    </SettingsCard>
  )
}

function Sessions() {
  const { sessions, now } = Route.useLoaderData()
  const { save, saving } = useSave()
  const others = sessions.filter((s) => !s.current).length
  return (
    <SettingsCard
      title="Where you’re signed in"
      description="Each browser stays signed in for 90 days after it was last used."
    >
      <div className="grid gap-4">
        <ul className="divide-y rounded-xl border text-sm">
          {sessions.map((s) => {
            const device = deviceName(s.user_agent)
            const Icon = /iPhone|Android/.test(device) ? IconDeviceMobile : IconDeviceDesktop
            return (
              <li key={s.hash} className="flex min-h-14 items-center gap-3 px-3 py-2">
                <Icon className="size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate font-medium">
                    {device === 'Passkey' ? 'Unknown browser' : device}
                    {s.current && <Badge variant="secondary">This browser</Badge>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Signed in <Ago at={s.created_at} now={now} /> · active <Ago at={s.last_seen_at} now={now} />
                  </p>
                </div>
                {!s.current && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    className="max-sm:h-10"
                    onClick={() => void save(() => signOutSession({ data: { hash: s.hash } }), 'Signed out')}
                  >
                    Sign out
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
        {others > 0 && (
          <div>
            <Button
              variant="outline"
              disabled={saving}
              className="max-sm:h-10"
              onClick={() => {
                if (!confirm(`Sign out of ${others === 1 ? 'the other browser' : `the ${others} other browsers`}?`))
                  return
                void save(() => signOutSession({ data: { others: true } }), 'Signed out everywhere else')
              }}
            >
              Sign out everywhere else
            </Button>
          </div>
        )}
      </div>
    </SettingsCard>
  )
}
