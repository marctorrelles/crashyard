import { createFileRoute } from '@tanstack/react-router'
import { IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-react'
import { SettingsCard, useSave } from '@/components/settings'
import { usePreferences } from '@/components/shell'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { Preferences } from '@/data/settings'
import { savePreference } from '@/fns'

export const Route = createFileRoute('/settings/appearance')({
  head: () => ({ meta: [{ title: 'Appearance · Settings · crashyard' }] }),
  component: Appearance,
})

const THEMES = [
  { value: 'system', label: 'System', icon: IconDeviceDesktop },
  { value: 'light', label: 'Light', icon: IconSun },
  { value: 'dark', label: 'Dark', icon: IconMoon },
] as const

/** At once, as the root's script does before paint from the cookie the save sets */
function apply(theme: Preferences['theme']) {
  const dark = theme === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : theme === 'dark'
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

function Appearance() {
  const { theme } = usePreferences()
  const { save } = useSave()
  return (
    <SettingsCard title="Theme" description="System follows your device, and changes with it.">
      <ToggleGroup
        type="single"
        variant="outline"
        value={theme}
        onValueChange={(v) => {
          if (!v) return
          apply(v as Preferences['theme'])
          void save(() => savePreference({ data: { key: 'theme', value: v } }))
        }}
        aria-label="Theme"
      >
        {THEMES.map((t) => (
          <ToggleGroupItem key={t.value} value={t.value} className="h-10 px-4">
            <t.icon />
            {t.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </SettingsCard>
  )
}
