import { getRouteApi } from '@tanstack/react-router'
import { Code } from '@/components/linking'
import { SaveButton, SettingsCard, useSave } from '@/components/settings'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { updateProject } from '@/fns'

const parent = getRouteApi('/settings/projects/$slug')

export function Source() {
  const { project } = parent.useLoaderData()
  const { save, saving } = useSave()
  return (
    <SettingsCard
      title="Repository"
      description="Open stack frames at their line in the repository, and see each release’s commits."
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          const repo = new FormData(e.currentTarget).get('repo')
          void save(() => updateProject({ data: { id: project.id, repo_url: repo } }))
        }}
      >
        <div className="grid gap-2">
          <Label htmlFor="repo">Repository</Label>
          <div className="flex gap-2">
            <Input
              id="repo"
              name="repo"
              type="url"
              defaultValue={project.repo_url ?? ''}
              placeholder="https://github.com/owner/repo"
              maxLength={300}
            />
            <SaveButton saving={saving} />
          </div>
        </div>
        <div className="grid min-w-0 gap-2">
          <p className="text-sm">
            Send each release’s commits from its checkout, using the release name the SDK reports. The first time, the
            full history is sent so crashyard can find every file.
          </p>
          <Code
            text={`sentry-cli releases new -p ${project.slug} "$RELEASE"\nsentry-cli releases set-commits "$RELEASE" --local --initial-depth 100000`}
          />
        </div>
      </form>
    </SettingsCard>
  )
}
