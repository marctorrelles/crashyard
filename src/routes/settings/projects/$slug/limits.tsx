import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { LimitInputs, SaveButton, SettingsCard, useSave } from '@/components/settings'
import { updateProject } from '@/fns'

export const Route = createFileRoute('/settings/projects/$slug/limits')({ component: Limits })

const parent = getRouteApi('/settings/projects/$slug')

function Limits() {
  const { project } = parent.useLoaderData()
  const { save, saving } = useSave()
  return (
    <SettingsCard
      title="Limits and retention"
      description="How much this project takes in a day, and how long it keeps it."
    >
      <form
        className="grid gap-4 @xl:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          const values = Object.fromEntries(new FormData(e.currentTarget))
          void save(() => updateProject({ data: { id: project.id, ...values } }))
        }}
      >
        <LimitInputs values={project} />
        <div className="@xl:col-span-2">
          <SaveButton saving={saving} />
        </div>
      </form>
    </SettingsCard>
  )
}
