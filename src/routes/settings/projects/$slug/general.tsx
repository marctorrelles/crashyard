import { createFileRoute, getRouteApi, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { Hint, SaveButton, SettingsCard, useSave } from '@/components/settings'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { updateProject } from '@/fns'
import { Delete } from './-delete'

export const Route = createFileRoute('/settings/projects/$slug/general')({ component: GeneralTab })

const parent = getRouteApi('/settings/projects/$slug')

// The project itself, and deleting it
function GeneralTab() {
  return (
    <>
      <General />
      <Delete />
    </>
  )
}

function General() {
  const { project } = parent.useLoaderData()
  const navigate = useNavigate()
  const { save, saving } = useSave()
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
          const saved = await save(() => updateProject({ data: { id: project.id, name, slug } }))
          if (saved && slug !== project.slug)
            await navigate({ to: '/settings/projects/$slug/general', params: { slug }, replace: true })
        }}
      >
        <div className="grid gap-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" defaultValue={project.name} required maxLength={80} />
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
