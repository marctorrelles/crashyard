import { createFileRoute, getRouteApi, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { SettingsCard } from '@/components/settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { deleteProject } from '@/fns'

export const Route = createFileRoute('/settings/projects/$slug/delete')({ component: Delete })

const parent = getRouteApi('/settings/projects/$slug')

function Delete() {
  const { project } = parent.useLoaderData()
  const navigate = useNavigate()
  const [typed, setTyped] = useState('')
  return (
    <SettingsCard
      title="Delete project"
      description={`Deletes ${project.name} with all its issues, events, logs and uploads. This can’t be undone.`}
      className="border-destructive/40"
    >
      <div className="flex flex-wrap gap-2">
        <Input
          className="max-w-xs"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={`Type ${project.slug} to confirm`}
          aria-label="Project to delete"
        />
        <Button
          variant="destructive"
          disabled={typed !== project.slug}
          className="max-sm:h-10"
          onClick={async () => {
            await deleteProject({ data: { id: project.id } })
            toast.success(`${project.name} deleted`)
            await navigate({ to: '/' })
          }}
        >
          Delete project
        </Button>
      </div>
    </SettingsCard>
  )
}
