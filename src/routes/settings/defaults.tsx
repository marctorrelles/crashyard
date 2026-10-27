import { createFileRoute } from '@tanstack/react-router'
import { LimitInputs, SaveButton, SettingsCard, useSave } from '@/components/settings'
import { getInstanceSettings, saveProjectDefaults } from '@/fns'

export const Route = createFileRoute('/settings/defaults')({
  loader: () => getInstanceSettings(),
  head: () => ({ meta: [{ title: 'New-project defaults · Settings · crashyard' }] }),
  component: Defaults,
})

function Defaults() {
  const { defaults } = Route.useLoaderData()
  const { save, saving } = useSave()
  return (
    <SettingsCard
      title="New-project defaults"
      description="What each new project starts with. Projects you already have keep their own."
    >
      <form
        className="grid gap-4 @xl:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          const values = Object.fromEntries(new FormData(e.currentTarget))
          void save(() => saveProjectDefaults({ data: values }))
        }}
      >
        <LimitInputs values={defaults} />
        <div className="@xl:col-span-2">
          <SaveButton saving={saving} />
        </div>
      </form>
    </SettingsCard>
  )
}
