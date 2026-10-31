import { getRouteApi } from '@tanstack/react-router'
import { useState } from 'react'
import { Hint, SaveButton, SettingsCard, useSave } from '@/components/settings'
import { usePreferences } from '@/components/shell'
import { formatTime, useTimePrefs } from '@/components/time'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { savePreference } from '@/fns'

// Preferences' date and time, its example time from that page's loader
const page = getRouteApi('/settings/preferences')

const ZONES = Intl.supportedValuesOf('timeZone')

export function DateAndTime() {
  const { timeZone, clock } = usePreferences()
  const { now } = page.useLoaderData()
  const prefs = useTimePrefs()
  const { save, saving } = useSave()
  const [zone, setZone] = useState(timeZone ?? '')
  return (
    <>
      <SettingsCard
        title="Time zone"
        description={`Dates and times show in it everywhere. Now it’s ${formatTime(now, prefs, 'datetime')} in ${prefs.zone}.`}
      >
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void save(() => savePreference({ data: { key: 'timeZone', value: zone.trim() || null } }))
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="zone">Time zone</Label>
            <Input
              id="zone"
              list="zones"
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              placeholder="Your browser’s"
              className="@xl:max-w-sm"
            />
            <datalist id="zones">
              {ZONES.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
            <Hint>Leave it empty to use your browser’s, for example Europe/Madrid or America/New_York.</Hint>
          </div>
          <div>
            <SaveButton saving={saving} />
          </div>
        </form>
      </SettingsCard>
      <SettingsCard title="Clock">
        <ToggleGroup
          type="single"
          variant="outline"
          value={clock}
          onValueChange={(v) => v && void save(() => savePreference({ data: { key: 'clock', value: v } }))}
          aria-label="Clock"
        >
          <ToggleGroupItem value="24" className="h-10 px-3 sm:px-4">
            24-hour, {formatTime(Date.UTC(2026, 0, 1, 15, 30), { zone: 'UTC', clock: '24' }, 'time')}
          </ToggleGroupItem>
          <ToggleGroupItem value="12" className="h-10 px-3 sm:px-4">
            12-hour, {formatTime(Date.UTC(2026, 0, 1, 15, 30), { zone: 'UTC', clock: '12' }, 'time')}
          </ToggleGroupItem>
        </ToggleGroup>
      </SettingsCard>
    </>
  )
}
