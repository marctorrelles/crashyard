import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { IconKey, IconTrash } from '@tabler/icons-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Ago } from '@/components/bits'
import { Code } from '@/components/linking'
import { SettingsCard, useSave } from '@/components/settings'
import { Empty } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createToken, getTokens, revokeToken } from '@/fns'

export const Route = createFileRoute('/settings/tokens')({
  loader: () => getTokens(),
  head: () => ({ meta: [{ title: 'Tokens · Settings · crashyard' }] }),
  component: Tokens,
})

const ALL = 'all'

function Tokens() {
  const { tokens, projects, origin, now } = Route.useLoaderData()
  const router = useRouter()
  const { save } = useSave()
  const [made, setMade] = useState<string>()
  const [name, setName] = useState('')
  const [project, setProject] = useState(ALL)
  return (
    <>
      <SettingsCard
        title="Upload tokens"
        description="sentry-cli and the build plugins use these as SENTRY_AUTH_TOKEN to upload debug files and source maps and to create releases. They can do nothing else."
      >
        <div className="grid gap-4">
          {made && (
            <div className="grid gap-1 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="text-sm">Copy the token now. It won’t be shown again.</p>
              <Code text={made} />
            </div>
          )}
          <form
            className="grid gap-3 @xl:grid-cols-[1fr_1fr_auto] @xl:items-end"
            onSubmit={async (e) => {
              e.preventDefault()
              try {
                setMade(await createToken({ data: { name, project: project === ALL ? undefined : Number(project) } }))
                setName('')
                await router.invalidate()
              } catch (error) {
                toast.error(error instanceof Error ? error.message : 'The token couldn’t be created. Try again.')
              }
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="token-name">Name</Label>
              <Input
                id="token-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="For example Xcode or CI"
                maxLength={80}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="token-project">Project</Label>
              <Select value={project} onValueChange={setProject}>
                <SelectTrigger id="token-project" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All projects</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" variant="outline" className="max-sm:h-10">
              <IconKey data-icon="inline-start" />
              Create token
            </Button>
          </form>
          {tokens.length === 0 ? (
            <Empty icon={IconKey} title="No tokens yet" compact>
              Create one for each place that uploads, so you can revoke one without the others.
            </Empty>
          ) : (
            <ul className="divide-y rounded-xl border text-sm">
              {tokens.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {t.name}{' '}
                      <span className="font-normal text-muted-foreground">
                        · {t.project ? (projects.find((p) => p.slug === t.project)?.name ?? t.project) : 'All projects'}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t.created_by} · created <Ago at={t.created_at} now={now} />
                      {t.last_used_at ? (
                        <>
                          {' '}
                          · used <Ago at={t.last_used_at} now={now} />
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
                    aria-label={`Delete ${t.name}`}
                    onClick={() => {
                      if (!confirm(`Delete ${t.name}? Uploads using it stop working. This can’t be undone.`)) return
                      void save(() => revokeToken({ data: { id: t.id } }), `${t.name} deleted`)
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

      {/* Each person makes their own, acting as them */}
      <SettingsCard
        title="Agents"
        description={
          <>
            Agents such as Claude Code reach crashyard over MCP with an agent token, which each person creates in{' '}
            <Link to="/settings/agent-tokens" className="font-medium text-foreground underline underline-offset-2">
              Agent tokens
            </Link>
            .
          </>
        }
      >
        <div className="grid min-w-0 gap-2">
          <Label>MCP URL</Label>
          <Code text={`${origin}/mcp`} />
        </div>
      </SettingsCard>
    </>
  )
}
