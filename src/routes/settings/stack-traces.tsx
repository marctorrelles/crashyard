import { createFileRoute } from '@tanstack/react-router'
import { SettingsCard, useSave } from '@/components/settings'
import { usePreferences } from '@/components/shell'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { savePreference } from '@/fns'

export const Route = createFileRoute('/settings/stack-traces')({
  head: () => ({ meta: [{ title: 'Stack traces · Settings · crashyard' }] }),
  component: StackTraces,
})

function StackTraces() {
  const { stackOrder, showOtherFrames } = usePreferences()
  const { save, saving } = useSave()
  return (
    <>
      <SettingsCard title="Frame order" description="Where a stack trace starts on an issue.">
        <ToggleGroup
          type="single"
          variant="outline"
          value={stackOrder}
          onValueChange={(v) => v && void save(() => savePreference({ data: { key: 'stackOrder', value: v } }))}
          aria-label="Frame order"
        >
          <ToggleGroupItem value="newest" className="h-10 px-4">
            Newest first
          </ToggleGroupItem>
          <ToggleGroupItem value="oldest" className="h-10 px-4">
            Oldest first
          </ToggleGroupItem>
        </ToggleGroup>
      </SettingsCard>
      <SettingsCard
        title="Other frames"
        description="Frames from system libraries and dependencies, outside your app’s code."
      >
        <div className="flex items-center gap-3">
          <Switch
            id="other"
            checked={showOtherFrames}
            disabled={saving}
            onCheckedChange={(on) => void save(() => savePreference({ data: { key: 'showOtherFrames', value: on } }))}
          />
          <Label htmlFor="other">Show other frames open</Label>
        </div>
      </SettingsCard>
    </>
  )
}
