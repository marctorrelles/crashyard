import { createFileRoute, Link } from '@tanstack/react-router'
import { IconChevronRight, IconFolder } from '@tabler/icons-react'
import { NewProject } from '@/components/new-project'
import { LimitInputs, SaveButton, SettingsCard, useSave } from '@/components/settings'
import { Empty, useProjects } from '@/components/shell'
import { getInstanceSettings, saveProjectDefaults } from '@/fns'

export const Route = createFileRoute('/settings/projects/')({
  loader: () => getInstanceSettings(),
  head: () => ({ meta: [{ title: 'Projects · Settings · crashyard' }] }),
  component: Projects,
})

// Every project, each opening its own settings, then what new ones start with; New project is in the page's header
// (../route.tsx)
function Projects() {
  const projects = useProjects()
  return (
    <>
      {projects.length ? (
        <List />
      ) : (
        <Empty icon={IconFolder} title="No projects yet" action={<NewProject />}>
          A project holds one app’s crashes, logs and releases.
        </Empty>
      )}
      <Defaults />
    </>
  )
}

function List() {
  const projects = useProjects()
  return (
    <ul className="divide-y rounded-xl border">
      {projects.map((p) => (
        <li key={p.id}>
          <Link
            to="/settings/projects/$slug/general"
            params={{ slug: p.slug }}
            className="flex min-h-12 items-center gap-3 px-4 py-3 hover:bg-muted/40"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{p.name}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">{p.slug}</p>
            </div>
            <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </Link>
        </li>
      ))}
    </ul>
  )
}

function Defaults() {
  const { defaults } = Route.useLoaderData()
  const { save, saving } = useSave()
  return (
    <SettingsCard
      title="Defaults for new projects"
      description="The limits and retention each new project starts with. Projects you already have keep their own."
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
