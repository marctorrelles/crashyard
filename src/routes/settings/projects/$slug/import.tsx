import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { Hint, SettingsCard } from '@/components/settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { importFromSentry } from '@/fns'

export const Route = createFileRoute('/settings/projects/$slug/import')({ component: Import })

const parent = getRouteApi('/settings/projects/$slug')

type Progress = { imported: number; skipped: number; cursor: string | null; done: boolean; error?: string }

// The browser asks for one page after another (src/ingest/import.ts), so the import runs while this page is open and
// can continue from the page it stopped at
function Import() {
  const { project } = parent.useLoaderData()
  const router = useRouter()
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)

  const run = async (form: HTMLFormElement, from: Progress | null) => {
    const f = new FormData(form)
    let p: Progress = from ?? { imported: 0, skipped: 0, cursor: null, done: false }
    setRunning(true)
    setProgress({ ...p, error: undefined })
    try {
      do {
        const page = await importFromSentry({
          data: {
            project_id: project.id,
            base: f.get('base'),
            org: f.get('org'),
            project: f.get('project'),
            token: f.get('token'),
            cursor: p.cursor,
          },
        })
        p = {
          imported: p.imported + page.imported,
          skipped: p.skipped + page.skipped,
          cursor: page.next,
          done: !page.next,
        }
        setProgress(p)
      } while (p.cursor)
      await router.invalidate()
    } catch (error) {
      setProgress({ ...p, error: error instanceof Error ? error.message : 'The import stopped. Try again.' })
    } finally {
      setRunning(false)
    }
  }

  return (
    <SettingsCard
      title="Import from Sentry"
      description="Bring this project’s issues over from Sentry, each with its latest event, counts, status and comments. Events the SDK sends from now on join the same issues."
    >
      <form
        className="grid gap-4 @xl:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          void run(e.currentTarget, null)
        }}
      >
        <div className="grid gap-2 @xl:col-span-2">
          <Label htmlFor="base">Sentry address</Label>
          <Input id="base" name="base" defaultValue="https://sentry.io" required className="@xl:max-w-sm" />
          <Hint>For an organization in the EU, use https://de.sentry.io. For your own Sentry, its address.</Hint>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="org">Organization slug</Label>
          <Input id="org" name="org" required autoComplete="off" spellCheck={false} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="project">Project slug</Label>
          <Input id="project" name="project" required autoComplete="off" spellCheck={false} />
        </div>
        <div className="grid gap-2 @xl:col-span-2">
          <Label htmlFor="token">Auth token</Label>
          <Input id="token" name="token" type="password" required autoComplete="off" className="font-mono" />
          <Hint>
            Create one in Sentry under Settings, Auth Tokens, with the event:read and project:read scopes. It’s used for
            this import only and never stored.
          </Hint>
        </div>
        <div className="grid gap-3 @xl:col-span-2">
          {progress && (
            <p
              className={
                progress.error
                  ? 'rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm'
                  : 'rounded-lg border px-3 py-2 text-sm'
              }
              role="status"
            >
              {progress.error
                ? `${progress.error}${progress.imported ? ` ${progress.imported} issues were imported before it stopped.` : ''}`
                : progress.done
                  ? `Imported ${progress.imported} issues.${progress.skipped ? ` ${progress.skipped} were here already.` : ''}`
                  : `Importing… ${progress.imported} issues so far. Keep this page open until it finishes.`}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={running} className="max-sm:h-10">
              Import issues
            </Button>
            {progress?.error && progress.cursor && (
              <Button
                type="button"
                variant="outline"
                disabled={running}
                className="max-sm:h-10"
                onClick={(e) => void run(e.currentTarget.form!, progress)}
              >
                Continue import
              </Button>
            )}
          </div>
        </div>
      </form>
    </SettingsCard>
  )
}
