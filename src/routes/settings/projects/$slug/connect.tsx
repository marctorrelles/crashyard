import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { useState } from 'react'
import { Code, Linking } from '@/components/linking'
import { NeedsPaid } from '@/components/plan'
import { Hint, SaveButton, SettingsCard, Subhead, useSave } from '@/components/settings'
import { Time } from '@/components/time'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { updateProject } from '@/fns'
import { Keys } from './-keys'

export const Route = createFileRoute('/settings/projects/$slug/connect')({ component: Connect })

const parent = getRouteApi('/settings/projects/$slug')

// What an app needs to send here: the DSN and setup, Workers' runs, and its keys
function Connect() {
  const { project, dsn, publicKey, origin } = parent.useLoaderData()
  return (
    <>
      <App project={project} dsn={dsn} publicKey={publicKey} origin={origin} />
      <Workers />
      <Subhead id="client-keys">Client keys</Subhead>
      <Keys />
    </>
  )
}

type Loaded = ReturnType<typeof parent.useLoaderData>

function App({ project, dsn, publicKey, origin }: Pick<Loaded, 'project' | 'dsn' | 'publicKey' | 'origin'>) {
  return (
    <SettingsCard
      title="Connect an app"
      description={
        <>
          Give the app’s Sentry SDK this DSN and its events start arriving here. Other keys are under{' '}
          <a href="#client-keys" className="font-medium text-foreground underline underline-offset-2">
            Client keys
          </a>
          .
        </>
      }
    >
      <div className="mb-5 grid min-w-0 gap-2">
        <Label>DSN</Label>
        <Code text={dsn} />
      </div>
      <Linking dsn={dsn} origin={origin} id={project.id} publicKey={publicKey} />
    </SettingsCard>
  )
}

/** Cloudflare Workers that send their runs here through `tail_consumers` (src/api/tail.ts) */
function Workers() {
  const { project, workersSeen } = parent.useLoaderData()
  const { save, saving } = useSave()
  const [workers, setWorkers] = useState((JSON.parse(project.workers ?? '[]') as string[]).join('\n'))
  const [exceptions, setExceptions] = useState(project.worker_exceptions === 1)
  const listed = workers.split(/[\s,]+/).filter(Boolean)
  // One click: added to the list and saved
  const watch = (name: string) => {
    const next = [...listed, name].join('\n')
    setWorkers(next)
    void save(
      () => updateProject({ data: { id: project.id, workers: next, worker_exceptions: exceptions } }),
      `Watching ${name}`,
    )
  }
  return (
    <SettingsCard
      title="Cloudflare Workers"
      description="Catch the failures a Worker's Sentry SDK can't send, such as running out of CPU time or memory. It needs the Workers Paid plan."
    >
      <form
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault()
          void save(() => updateProject({ data: { id: project.id, workers, worker_exceptions: exceptions } }))
        }}
      >
        <NeedsPaid>
          Your Cloudflare account is on Workers Free. Tail Workers need Workers Paid, so no Worker can send its runs
          here until you move to it.
        </NeedsPaid>
        <div className="grid min-w-0 gap-2">
          <Label>In each Worker's wrangler file</Label>
          <Code text={'"tail_consumers": [{ "service": "crashyard" }]'} />
          <Hint>Use this crashyard's own Worker name if you changed it. Then deploy the Worker again.</Hint>
        </div>
        <div className="grid gap-2">
          <Label>Workers sending runs here</Label>
          {workersSeen.length ? (
            <ul className="divide-y rounded-lg border">
              {workersSeen.map((w) => {
                const elsewhere = w.projects.filter((slug) => slug !== project.slug)
                return (
                  <li key={w.name} className="flex items-center gap-3 px-3 py-2">
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <p className="truncate font-mono text-xs">{w.name}</p>
                      <p className="text-xs text-muted-foreground">
                        Last run <Time at={w.lastRun} style="dayTime" />
                        {elsewhere.length > 0 && ` · Watched in ${elsewhere.join(', ')}`}
                      </p>
                    </div>
                    {listed.includes(w.name) ? (
                      <span className="text-xs text-muted-foreground">Watched</span>
                    ) : (
                      <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => watch(w.name)}>
                        Watch Worker
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          ) : (
            <Hint>No Worker has sent runs here yet. Once one with the line above runs, it shows up here to watch.</Hint>
          )}
        </div>
        <div className="grid gap-2">
          <Label htmlFor="workers">Workers to watch</Label>
          <Textarea
            id="workers"
            value={workers}
            onChange={(e) => setWorkers(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder="my-api"
            className="font-mono text-xs"
          />
          <Hint>
            One Worker name a line, as its wrangler file names it. Workers that haven't run yet can be added here.
          </Hint>
        </div>
        <div className="flex items-start gap-3">
          <Switch id="worker-exceptions" checked={exceptions} onCheckedChange={setExceptions} className="mt-0.5" />
          <div className="grid gap-0.5">
            <Label htmlFor="worker-exceptions">Report uncaught exceptions too</Label>
            <Hint>For Workers without the Sentry SDK. With the SDK, leave it off, or each error arrives twice.</Hint>
          </div>
        </div>
        <div>
          <SaveButton saving={saving} />
        </div>
      </form>
    </SettingsCard>
  )
}
