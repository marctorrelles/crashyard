import { createFileRoute } from '@tanstack/react-router'
import { IconMailPlus, IconTrash, IconUserPlus } from '@tabler/icons-react'
import { useState } from 'react'
import { Ago } from '@/components/bits'
import { Code } from '@/components/linking'
import { Hint, SettingsCard, useSave } from '@/components/settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { INVITE_DAYS, type Role, ROLE_HINTS, ROLE_LABELS, ROLES } from '@/data/people'
import { changeRole, createInvite, getPeople, removePerson, revokeInvite } from '@/fns'

export const Route = createFileRoute('/settings/people')({
  loader: () => getPeople(),
  head: () => ({ meta: [{ title: 'People · Settings · crashyard' }] }),
  component: People,
})

function RoleSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id?: string
  value: Role
  onChange: (role: Role) => void
  disabled?: boolean
}) {
  return (
    <Select value={value} onValueChange={(r) => onChange(r as Role)} disabled={disabled}>
      <SelectTrigger id={id} className="w-full max-sm:h-10" aria-label={id ? undefined : 'Role'}>
        {/* The trigger shows the role alone, the menu each role with what it can do */}
        <SelectValue>{ROLE_LABELS[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {ROLES.map((r) => (
          <SelectItem key={r} value={r}>
            <span className="grid text-left">
              <span>{ROLE_LABELS[r]}</span>
              <span className="text-xs text-muted-foreground">{ROLE_HINTS[r]}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function People() {
  const { users, invites, me, now } = Route.useLoaderData()
  const { save, saving } = useSave()
  const [link, setLink] = useState<string>()
  const [role, setRole] = useState<Role>('member')
  const [email, setEmail] = useState('')
  return (
    <>
      <SettingsCard title="People" description="Everyone who can sign in, and what they can do.">
        <ul className="divide-y rounded-xl border text-sm">
          {users.map((u) => (
            <li key={u.id} className="grid gap-2 px-3 py-2.5 @xl:grid-cols-[minmax(0,1fr)_11rem_auto] @xl:items-center">
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {u.name}
                  {u.id === me && <span className="font-normal text-muted-foreground"> · you</span>}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {u.email} ·{' '}
                  {u.last_seen_at ? (
                    <>
                      active <Ago at={u.last_seen_at} now={now} />
                    </>
                  ) : (
                    'never signed in'
                  )}{' '}
                  · {u.passkeys === 1 ? '1 passkey' : `${u.passkeys} passkeys`}
                </p>
              </div>
              <div className="flex items-center gap-2 @xl:contents">
                <div className="min-w-0 flex-1">
                  <RoleSelect
                    value={u.role}
                    disabled={saving}
                    onChange={(r) =>
                      void save(
                        () => changeRole({ data: { id: u.id, role: r } }),
                        `${u.name} is now ${/^[aeiou]/i.test(r) ? 'an' : 'a'} ${ROLE_LABELS[r].toLowerCase()}`,
                      )
                    }
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="max-sm:size-10"
                  aria-label={`Remove ${u.name}`}
                  disabled={u.id === me}
                  onClick={() => {
                    if (
                      !confirm(
                        `Remove ${u.name}? They’re signed out at once and can’t sign in again. What they did stays.`,
                      )
                    )
                      return
                    void save(() => removePerson({ data: { id: u.id } }), `${u.name} removed`)
                  }}
                >
                  <IconTrash />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </SettingsCard>

      <SettingsCard
        title="Invite someone"
        description={`An invite is a link to send them. It works once, for ${INVITE_DAYS} days.`}
      >
        <div className="grid gap-4">
          {link && (
            <div className="grid gap-1 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="text-sm">Send this link. It won’t be shown again.</p>
              <Code text={link} />
            </div>
          )}
          <form
            className="grid gap-3 @xl:grid-cols-[1fr_11rem_auto] @xl:items-start"
            onSubmit={(e) => {
              e.preventDefault()
              void save(async () => {
                setLink(await createInvite({ data: { role, email } }))
                setEmail('')
              }, 'Invite created')
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Optional"
                maxLength={200}
              />
              <Hint>When set, only that email can join with it.</Hint>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-role">Role</Label>
              <RoleSelect id="invite-role" value={role} onChange={setRole} />
            </div>
            <Button type="submit" variant="outline" disabled={saving} className="@xl:mt-[1.375rem] max-sm:h-10">
              <IconUserPlus data-icon="inline-start" />
              Create invite
            </Button>
          </form>
          {invites.length > 0 && (
            <div className="grid gap-2">
              <p className="text-sm font-medium">Waiting to be used</p>
              <ul className="divide-y rounded-xl border text-sm">
                {invites.map((i) => (
                  <li key={i.hash} className="flex items-center gap-3 px-3 py-2">
                    <IconMailPlus className="size-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {i.email ?? 'Anyone with the link'}{' '}
                        <span className="font-normal text-muted-foreground">· {ROLE_LABELS[i.role]}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {i.created_by} · created <Ago at={i.created_at} now={now} /> ·{' '}
                        {(() => {
                          const days = Math.ceil((i.expires_at - now) / 864e5)
                          return days <= 1 ? 'ends today' : `ends in ${days} days`
                        })()}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="max-sm:size-10"
                      aria-label="Withdraw invite"
                      onClick={() => {
                        if (!confirm('Withdraw this invite? Its link stops working.')) return
                        void save(() => revokeInvite({ data: { hash: i.hash } }), 'Invite withdrawn')
                      }}
                    >
                      <IconTrash />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </SettingsCard>
    </>
  )
}
