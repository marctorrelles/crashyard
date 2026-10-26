import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { useState } from 'react'
import { Hint, SaveButton, SettingsCard, useSave } from '@/components/settings'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PRIORITY_LABELS } from '@/components/priority'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { updateProject } from '@/fns'
import { PRIORITIES, type Priority, priorityFor } from '@/ingest/priority'
import { LEVELS } from '@/notify/notice'

export const Route = createFileRoute('/settings/projects/$slug/issues')({ component: Issues })

const parent = getRouteApi('/settings/projects/$slug')

function Issues() {
  return (
    <>
      <AutoResolve />
      <Priorities />
    </>
  )
}

function AutoResolve() {
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

function Priorities() {
  const { project } = parent.useLoaderData()
  const { save, saving } = useSave()
  const [chosen, setChosen] = useState<Record<string, Priority>>(() =>
    Object.fromEntries(LEVELS.map((l) => [l, priorityFor(project.priorities, l)])),
  )
  return (
    <SettingsCard
      title="Priority of new issues"
      description="A new issue starts with the priority of its level. Change it on the issue whenever it matters more or less."
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save(() => updateProject({ data: { id: project.id, priorities: chosen } }))
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[8rem_12rem] sm:items-center">
          {LEVELS.map((level) => (
            <div key={level} className="contents">
              <Label htmlFor={`priority-${level}`}>{level[0].toUpperCase() + level.slice(1)}</Label>
              <Select value={chosen[level]} onValueChange={(v) => setChosen({ ...chosen, [level]: v as Priority })}>
                <SelectTrigger id={`priority-${level}`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PRIORITY_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
        <Hint>Issues made before a change keep their priority.</Hint>
        <div>
          <SaveButton saving={saving} />
        </div>
      </form>
    </SettingsCard>
  )
}
