import { createFileRoute } from '@tanstack/react-router'
import { IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-react'
import { SettingsCard, useSave } from '@/components/settings'
import { usePreferences } from '@/components/shell'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { Preferences } from '@/data/settings'
import { savePreference } from '@/fns'

export const Route = createFileRoute('/settings/appearance')({
  head: () => ({ meta: [{ title: 'Appearance · Settings · crashyard' }] }),
  component: Appearance,
})

const MODES = [
  { value: 'system', label: 'System', icon: IconDeviceDesktop },
  { value: 'light', label: 'Light', icon: IconSun },
  { value: 'dark', label: 'Dark', icon: IconMoon },
] as const

const STYLES: { value: Preferences['style']; name: string; description: string }[] = [
  { value: 'hazard', name: 'Hazard', description: 'The default. Safety orange on steel, with a dark sidebar.' },
  { value: 'classic', name: 'Classic', description: 'Neutral greys, as crashyard first looked.' },
  { value: 'terminal', name: 'Terminal', description: 'Monospace and square. Dense, with green on black.' },
  { value: 'soft', name: 'Soft', description: 'Rounded corners and type, in lavender and violet.' },
  { value: 'editorial', name: 'Editorial', description: 'Serif type on cream paper, in ink and dark red.' },
]

const BARS = [3, 5, 4, 7, 6, 9, 5, 8, 11, 7, 10, 14]

/** A tile's picture: crashyard in small, its sidebar, a page with Resolve and a chart, in the tile's theme */
function MiniWindow() {
  return (
    <span className="flex h-32 border-b bg-background" aria-hidden="true">
      <span className="grid w-14 content-start gap-1.5 bg-sidebar p-2">
        <span className="mb-1 size-3 rounded-full bg-sidebar-foreground" />
        <span className="h-1.5 rounded-full bg-sidebar-primary" />
        <span className="h-1.5 w-4/5 rounded-full bg-sidebar-foreground/30" />
        <span className="h-1.5 w-3/5 rounded-full bg-sidebar-foreground/30" />
        <span className="h-1.5 w-4/5 rounded-full bg-sidebar-foreground/30" />
      </span>
      <span className="grid flex-1 content-start gap-2 p-2.5">
        <span className="flex items-center justify-between">
          <span className="h-2 w-16 rounded-full bg-foreground/80" />
          <span className="rounded-sm bg-primary px-1.5 text-[9px] leading-4 text-primary-foreground">Resolve</span>
        </span>
        <span className="flex h-16 items-end gap-0.5 rounded-md border bg-card p-1.5">
          {BARS.map((h, i) => (
            <span key={i} className="flex-1 rounded-t-[2px] bg-chart-1" style={{ height: `${h * 6}%` }} />
          ))}
        </span>
        <span className="h-1.5 w-3/4 rounded-full bg-muted-foreground/40" />
      </span>
    </span>
  )
}

/** At once, as the root's script does before paint from the cookies the save sets */
function applyMode(theme: Preferences['theme']) {
  const dark = theme === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : theme === 'dark'
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

function Appearance() {
  const { theme, style } = usePreferences()
  const { save } = useSave()
  return (
    <>
      <SettingsCard title="Theme" description="It changes as you pick, on every device you sign in on.">
        {/* Each tile wears its own theme (data-style), so it previews it in the current light or dark */}
        <RadioGroup
          value={style}
          onValueChange={(v) => {
            document.documentElement.dataset.style = v
            void save(() => savePreference({ data: { key: 'style', value: v } }))
          }}
          aria-label="Theme"
          className="grid gap-3 @xl:grid-cols-2 @3xl:grid-cols-3"
        >
          {STYLES.map((s) => (
            <Label
              key={s.value}
              htmlFor={`style-${s.value}`}
              data-style={s.value}
              className="grid cursor-pointer content-start gap-0 overflow-hidden rounded-xl border bg-background font-sans font-normal text-foreground has-data-[state=checked]:border-primary has-data-[state=checked]:ring-2 has-data-[state=checked]:ring-primary/40"
            >
              <MiniWindow />
              <span className="flex items-start gap-2.5 p-3">
                <RadioGroupItem id={`style-${s.value}`} value={s.value} className="mt-0.5" />
                <span className="grid gap-0.5">
                  <span className="text-sm font-medium">{s.name}</span>
                  <span className="text-xs text-muted-foreground">{s.description}</span>
                </span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      </SettingsCard>
      <SettingsCard title="Light or dark" description="System follows your device, and changes with it.">
        <ToggleGroup
          type="single"
          variant="outline"
          value={theme}
          onValueChange={(v) => {
            if (!v) return
            applyMode(v as Preferences['theme'])
            void save(() => savePreference({ data: { key: 'theme', value: v } }))
          }}
          aria-label="Light or dark"
        >
          {MODES.map((t) => (
            <ToggleGroupItem key={t.value} value={t.value} className="h-10 px-4">
              <t.icon />
              {t.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingsCard>
    </>
  )
}
