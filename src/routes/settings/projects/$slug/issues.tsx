import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { useState } from 'react'
import { Hint, SaveButton, SettingsCard, useSave } from '@/components/settings'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { updateProject } from '@/fns'

export const Route = createFileRoute('/settings/projects/$slug/issues')({ component: Issues })

const parent = getRouteApi('/settings/projects/$slug')

function Issues() {
  const { project } = parent.useLoaderData()
  const { save, saving } = useSave()
  const [on, setOn] = useState(project.auto_resolve_days !== null)
  const [days, setDays] = useState(String(project.auto_resolve_days ?? 14))
  return (
    <SettingsCard
      title="Resolve on their own"
      description="Issues that stop happening are resolved after a while, so the list shows what still matters. One that happens again reopens as a regression."
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save(() => updateProject({ data: { id: project.id, auto_resolve_days: on ? days : null } }))
        }}
      >
        <div className="flex items-center gap-3">
          <Switch id="auto" checked={on} onCheckedChange={setOn} />
          <Label htmlFor="auto">Resolve issues not seen for a number of days</Label>
        </div>
        {on && (
          <div className="grid gap-2">
            <Label htmlFor="days">Days without events</Label>
            <Input
              id="days"
              type="number"
              min={1}
              max={3650}
              inputMode="numeric"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="sm:max-w-40"
            />
            <Hint>Checked every hour.</Hint>
          </div>
        )}
        <div>
          <SaveButton saving={saving} />
        </div>
      </form>
    </SettingsCard>
  )
}
