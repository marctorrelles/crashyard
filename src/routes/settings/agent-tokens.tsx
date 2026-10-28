import { createFileRoute } from '@tanstack/react-router'
import { IconRobot, IconTrash } from '@tabler/icons-react'
import { useState } from 'react'
import { Ago } from '@/components/bits'
import { Code } from '@/components/linking'
import { Hint, SettingsCard, useSave } from '@/components/settings'
import { Empty } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createAgentToken, getAgentTokens, revokeAgentToken } from '@/fns'

export const Route = createFileRoute('/settings/agent-tokens')({
  loader: () => getAgentTokens(),
  head: () => ({ meta: [{ title: 'Agent tokens · Settings · crashyard' }] }),
  component: AgentTokens,
})

const SCOPES = { read: 'Read only', change: 'Read and change issues' } as const
const EXPIRY = { '30': '30 days', '90': '90 days', '365': 'A year', never: 'Never' } as const

// The tokens your agents reach crashyard with over MCP, acting as you
function AgentTokens() {
  const { tokens, mcp, now } = Route.useLoaderData()
  const { save, saving } = useSave()
  const [made, setMade] = useState<string>()
  const [name, setName] = useState('')
  const [scope, setScope] = useState<keyof typeof SCOPES>('read')
  const [expiry, setExpiry] = useState<keyof typeof EXPIRY>('90')
  return (
    <>
      <SettingsCard
        title="Agent tokens"
        description="Agents such as Claude Code reach crashyard over MCP with one of these. They act as you, and never do more than you can."
      >
        <div className="grid gap-4">
          {made && (
            <div className="grid min-w-0 gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="text-sm">Copy the token now. It won’t be shown again.</p>
              <Code text={made} />
              <p className="text-sm">To connect Claude Code, run:</p>
              <Code
                text={`claude mcp add --transport http crashyard ${mcp} --header "Authorization: Bearer ${made}"`}
              />
            </div>
          )}
          <form
            className="grid gap-3 @xl:grid-cols-[1fr_12rem_9rem_auto] @xl:items-end"
            onSubmit={(e) => {
              e.preventDefault()
              void save(async () => {
                setMade(
                  await createAgentToken({
                    data: { name, scope, days: expiry === 'never' ? null : (Number(expiry) as 30 | 90 | 365) },
                  }),
                )
                setName('')
              }, 'Token created')
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="agent-token-name">Name</Label>
              <Input
                id="agent-token-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="For example Claude Code on my laptop"
                maxLength={80}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="agent-token-scope">Can</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as keyof typeof SCOPES)}>
                <SelectTrigger id="agent-token-scope" className="w-full max-sm:h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(SCOPES).map(([v, label]) => (
                    <SelectItem key={v} value={v}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="agent-token-expiry">Expires after</Label>
              <Select value={expiry} onValueChange={(v) => setExpiry(v as keyof typeof EXPIRY)}>
                <SelectTrigger id="agent-token-expiry" className="w-full max-sm:h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EXPIRY).map(([v, label]) => (
                    <SelectItem key={v} value={v}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" variant="outline" disabled={saving} className="max-sm:h-10">
              <IconRobot data-icon="inline-start" />
              Create token
            </Button>
          </form>
          <Hint>Read and change issues lets it resolve, ignore and add notes, if your role allows it.</Hint>
          {tokens.length === 0 ? (
            <Empty icon={IconRobot} title="No agent tokens yet" compact>
              Create one for each agent, so you can delete one without the others.
            </Empty>
          ) : (
            <ul className="divide-y rounded-xl border text-sm">
              {tokens.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {t.name} <span className="font-normal text-muted-foreground">· {SCOPES[t.scope]}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Created <Ago at={t.created_at} now={now} />
                      {t.last_used_at ? (
                        <>
                          {' '}
                          · used <Ago at={t.last_used_at} now={now} />
                        </>
                      ) : (
                        ' · never used'
                      )}
                      {t.expires_at &&
                        (t.expires_at <= now
                          ? ' · expired'
                          : ` · expires in ${Math.ceil((t.expires_at - now) / 864e5)} days`)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="max-sm:size-10"
                    aria-label={`Delete ${t.name}`}
                    onClick={() => {
                      if (!confirm(`Delete ${t.name}? Agents using it lose access. This can’t be undone.`)) return
                      void save(() => revokeAgentToken({ data: { id: t.id } }), `${t.name} deleted`)
                    }}
                  >
                    <IconTrash />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingsCard>
    </>
  )
}
