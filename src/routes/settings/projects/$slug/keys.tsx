import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { IconKey } from '@tabler/icons-react'
import { useState } from 'react'
import { count } from '@/components/bits'
import { Code } from '@/components/linking'
import { Hint, SaveButton, SettingsCard, useSave } from '@/components/settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { createKey, updateKey } from '@/fns'

export const Route = createFileRoute('/settings/projects/$slug/keys')({ component: Keys })

const parent = getRouteApi('/settings/projects/$slug')

function Keys() {
  const { project, keys } = parent.useLoaderData()
  const { save, saving } = useSave()
  const [label, setLabel] = useState('')
  return (
    <>
      {/* The keys there are first, then a new one */}
      {keys.map((k) => (
        <KeyCard key={k.id} projectId={project.id} k={k} />
      ))}
      <SettingsCard
        title="Create key"
        description="A key per app or build lets you limit or turn off one without touching the others."
      >
        <form
          className="flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            if (await save(() => createKey({ data: { project: project.id, label } }), 'Key created')) setLabel('')
          }}
        >
          <Input
            className="max-w-xs"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Name it, for example iOS or Staging"
            aria-label="Key name"
            maxLength={80}
          />
          <Button type="submit" variant="outline" disabled={saving} className="max-sm:h-10">
            <IconKey data-icon="inline-start" />
            Create key
          </Button>
        </form>
      </SettingsCard>
    </>
  )
}

type Key = ReturnType<typeof parent.useLoaderData>['keys'][number]

function KeyCard({ projectId, k }: { projectId: number; k: Key }) {
  const { save, saving } = useSave()
  const [enabled, setEnabled] = useState(!!k.enabled)
  return (
    <SettingsCard
      title={k.label}
      description={`${count(k.today)} event${k.today === 1 ? '' : 's'} today${k.daily_limit !== null ? ` of ${count(k.daily_limit)}` : ''}${k.enabled ? '' : ' · Off'}`}
    >
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          const f = new FormData(e.currentTarget)
          void save(() =>
            updateKey({
              data: { project: projectId, id: k.id, label: f.get('label'), enabled, daily_limit: f.get('limit') },
            }),
          )
        }}
      >
        <div className="grid min-w-0 gap-2 sm:col-span-2">
          <Label>DSN</Label>
          <Code text={k.dsn} />
        </div>
        <div className="grid content-start gap-2">
          <Label htmlFor={`label-${k.id}`}>Name</Label>
          <Input id={`label-${k.id}`} name="label" defaultValue={k.label} maxLength={80} />
        </div>
        <div className="grid content-start gap-2">
          <Label htmlFor={`limit-${k.id}`}>Daily event limit</Label>
          <Input
            id={`limit-${k.id}`}
            name="limit"
            type="number"
            min={0}
            inputMode="numeric"
            defaultValue={k.daily_limit ?? ''}
            placeholder="The project’s limit"
          />
          <Hint>Leave it empty to use only the project’s limit.</Hint>
        </div>
        <div className="flex items-center gap-3 sm:col-span-2">
          <Switch
            id={`on-${k.id}`}
            checked={enabled}
            onCheckedChange={(on) => {
              if (!on && !confirm(`Disable ${k.label}? Apps using its DSN stop reporting within a minute.`)) return
              setEnabled(on)
            }}
          />
          <Label htmlFor={`on-${k.id}`}>{enabled ? 'On, events are accepted' : 'Off, events are refused'}</Label>
        </div>
        <div className="sm:col-span-2">
          <SaveButton saving={saving} />
        </div>
      </form>
    </SettingsCard>
  )
}
