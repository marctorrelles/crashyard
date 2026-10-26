import { createFileRoute } from '@tanstack/react-router'
import { Hint, SettingsCard, useSave } from '@/components/settings'
import { usePreferences, useProjects } from '@/components/shell'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { savePreference } from '@/fns'

export const Route = createFileRoute('/settings/home')({
  head: () => ({ meta: [{ title: 'Home · Settings · crashyard' }] }),
  component: Home,
})

const ALL = 'all'

function Home() {
  const { homeProject, homeRange } = usePreferences()
  const projects = useProjects()
  const { save } = useSave()
  return (
    <SettingsCard title="Overview" description="What the overview shows when you open crashyard.">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="home-project">Project</Label>
          <Select
            value={projects.some((p) => p.slug === homeProject) ? homeProject : ALL}
            onValueChange={(v) =>
              void save(() => savePreference({ data: { key: 'homeProject', value: v === ALL ? null : v } }))
            }
          >
            <SelectTrigger id="home-project" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All projects</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.slug}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Hint>The sidebar’s project menu still switches at any time.</Hint>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="home-range">Charts</Label>
          <Select
            value={homeRange ?? '30'}
            onValueChange={(v) => void save(() => savePreference({ data: { key: 'homeRange', value: v } }))}
          >
            <SelectTrigger id="home-range" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {['14', '30', '90'].map((d) => (
                <SelectItem key={d} value={d}>
                  The last {d} days
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </SettingsCard>
  )
}
