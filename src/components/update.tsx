import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Code } from '@/components/linking'
import { Hint } from '@/components/settings'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { connectCloudflare, disconnectCloudflare, getUpdate, installUpdate, setAutoUpdate } from '@/fns'

const DOCS = 'https://github.com/marctorrelles/crashyard/blob/main/docs/upgrading.md'
const TOKENS = 'https://dash.cloudflare.com/profile/api-tokens'
const link = 'font-medium underline underline-offset-2'

type Data = Awaited<ReturnType<typeof getUpdate>>

// Updating crashyard, for owners: installed from here with a Cloudflare API token (now, or daily on its own), or the
// manual way, a deploy (src/update/)
export function UpdateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [data, setData] = useState<Data | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = () => getUpdate().then(setData)
  useEffect(() => {
    if (open) void load()
  }, [open])

  const run = async (what: string, action: () => Promise<unknown>, done: string) => {
    setBusy(what)
    try {
      await action()
      toast.success(done)
      await load()
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That didn’t work. Try again.')
      return false
    } finally {
      setBusy(null)
    }
  }

  const update = data?.update
  const free = data?.paid === false
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{update ? `Update to crashyard ${update.version}` : 'Updates'}</DialogTitle>
          <DialogDescription>
            {!data ? (
              'Looking for a newer release…'
            ) : update ? (
              <>
                You’re on {data.version}.{' '}
                <a href={update.url} target="_blank" rel="noreferrer" className={link}>
                  See what’s new
                </a>
              </>
            ) : (
              `You’re on ${data.version}, the newest release.`
            )}
          </DialogDescription>
        </DialogHeader>
        {data && (
          <div className="grid min-w-0 gap-6">
            <section className="grid gap-3">
              <h3 className="text-sm font-medium">Automatically</h3>
              {data.script ? (
                <>
                  {update &&
                    (data.refusal ? (
                      <p className="text-sm text-muted-foreground">{data.refusal}</p>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          disabled={!!busy || free}
                          className="max-sm:h-10"
                          onClick={async () => {
                            if (await run('install', installUpdate, `crashyard ${update.version} is installed`))
                              location.reload()
                          }}
                        >
                          {busy === 'install' ? 'Installing…' : `Install ${update.version}`}
                        </Button>
                        {busy === 'install' && <Hint>This takes up to a minute. Keep this page open.</Hint>}
                      </div>
                    ))}
                  <div className="flex items-start gap-3">
                    <Switch
                      id="auto-update"
                      checked={data.auto}
                      disabled={!!busy || free}
                      onCheckedChange={(on) =>
                        void run(
                          'auto',
                          () => setAutoUpdate({ data: { on } }),
                          on ? 'Updates install automatically' : 'Updates wait for you',
                        )
                      }
                    />
                    <div className="grid gap-1">
                      <Label htmlFor="auto-update">Install updates automatically</Label>
                      <Hint>Every day at 03:40 UTC. A new major version always waits for you.</Hint>
                    </div>
                  </div>
                  {data.failed && (
                    <p className="text-sm text-destructive">
                      The automatic update to {data.failed.version} didn’t install. {data.failed.message}
                    </p>
                  )}
                  <Hint>
                    Connected to the Worker {data.script}.{' '}
                    <button
                      type="button"
                      className={link}
                      disabled={!!busy}
                      onClick={() => void run('disconnect', disconnectCloudflare, 'Cloudflare disconnected')}
                    >
                      Disconnect
                    </button>
                  </Hint>
                </>
              ) : (
                <form
                  className="grid gap-3"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>
                    void run(
                      'connect',
                      () => connectCloudflare({ data: { token: f.token, script: f.script } }),
                      'Cloudflare connected',
                    )
                  }}
                >
                  <p className="text-sm text-muted-foreground">
                    crashyard can install updates itself. It needs a Cloudflare API token that can edit this Worker and
                    its database.{' '}
                    <a href={TOKENS} target="_blank" rel="noreferrer" className={link}>
                      Create a token
                    </a>{' '}
                    with Workers Scripts: Edit and D1: Edit on your account, then paste it here.
                  </p>
                  <div className="grid gap-2">
                    <Label htmlFor="update-token">API token</Label>
                    <Input id="update-token" name="token" type="password" required maxLength={200} autoComplete="off" />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="update-script">Worker name</Label>
                    <Input id="update-script" name="script" required maxLength={63} defaultValue="crashyard" />
                    <Hint>The name in Workers & Pages. It’s crashyard unless you renamed it.</Hint>
                  </div>
                  <div>
                    <Button type="submit" variant="outline" disabled={!!busy} className="max-sm:h-10">
                      Connect Cloudflare
                    </Button>
                  </div>
                </form>
              )}
              {free && <Hint>Installing from here needs the Workers Paid plan.</Hint>}
            </section>
            <section className="grid min-w-0 gap-3">
              <h3 className="text-sm font-medium">Manually</h3>
              <p className="text-sm text-muted-foreground">From your clone of crashyard:</p>
              <Code text={'git pull\npnpm install\npnpm run deploy'} />
              <p className="text-sm text-muted-foreground">
                If you deployed with the button, merge the release’s tag into your copy of the repository. Workers
                Builds deploys it.
              </p>
              {update?.builder && (
                <p className="text-sm text-muted-foreground">
                  This update changes the SymCache builder. If you run it, start Docker before you deploy, so the deploy
                  builds its new image.
                </p>
              )}
              <Hint>
                <a href={DOCS} target="_blank" rel="noreferrer" className={link}>
                  Read the upgrading guide
                </a>
              </Hint>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
