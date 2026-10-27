import { createFileRoute, getRouteApi, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { PLATFORM_NAMES } from '@/components/new-project'
import { Hint, SaveButton, SettingsCard, useSave } from '@/components/settings'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { updateProject } from '@/fns'

export const Route = createFileRoute('/settings/projects/$slug/general')({ component: General })

const parent = getRouteApi('/settings/projects/$slug')

function General() {
  const { project } = parent.useLoaderData()
  const navigate = useNavigate()
  const { save, saving } = useSave()
  const [platform, setPlatform] = useState(project.platform)
  const [slug, setSlug] = useState(project.slug)
  return (
    <SettingsCard
      title="Project"
      description="Its name across crashyard, and the slug sentry-cli and build plugins use."
    >
      <form
        className="grid gap-4 @xl:grid-cols-2"
        onSubmit={async (e) => {
          e.preventDefault()
          const name = new FormData(e.currentTarget).get('name')
          const saved = await save(() => updateProject({ data: { id: project.id, name, slug, platform } }))
          if (saved && slug !== project.slug)
            await navigate({ to: '/settings/projects/$slug/general', params: { slug }, replace: true })
        }}
      >
        <div className="grid gap-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" defaultValue={project.name} required maxLength={80} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="platform">Platform</Label>
          <Select value={platform} onValueChange={(v) => setPlatform(v as typeof platform)}>
            <SelectTrigger id="platform" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(PLATFORM_NAMES).map(([value, name]) => (
                <SelectItem key={value} value={value}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Hint>Which setup guide Connect an app shows.</Hint>
        </div>
        <div className="grid gap-2 @xl:col-span-2">
          <Label htmlFor="slug">Slug</Label>
          <Input
            id="slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            required
            maxLength={40}
            pattern="[a-z0-9][a-z0-9\-]*"
            className="font-mono @xl:max-w-sm"
          />
          {slug !== project.slug ? (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
              Build scripts that set SENTRY_PROJECT to {project.slug} need {slug || 'the new slug'} after this, or their
              uploads stop.
            </p>
          ) : (
            <Hint>Lowercase letters, numbers and dashes. It appears in links and in SENTRY_PROJECT.</Hint>
          )}
        </div>
        <div className="@xl:col-span-2">
          <SaveButton saving={saving} />
        </div>
      </form>
    </SettingsCard>
  )
}
