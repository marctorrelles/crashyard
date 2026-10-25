import { createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { Code, Linking } from '@/components/linking'
import { PLATFORM_NAMES } from '@/components/new-project'
import { ProjectNav } from '@/components/project-nav'
import { Uploads } from '@/components/uploads'
import { PageHeader, Shell } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { deleteProject, getProjectSettings, rotateKey, updateProject } from '@/fns'

export const Route = createFileRoute('/projects/$slug/settings')({
  loader: async ({ params }) => {
    const data = await getProjectSettings({ data: { slug: params.slug } })
    if (!data) throw notFound()
    return data
  },
  head: ({ loaderData }) => ({ meta: [{ title: `Settings · ${loaderData?.project.name} · crashyard` }] }),
  component: Settings,
})

function Card({ title, children, description }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border p-4 sm:p-5">
      <h2 className="font-medium">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  )
}

function Settings() {
  const { project, dsn, origin, tokens, uploads, now } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const [platform, setPlatform] = useState(project.platform)
  const [confirmDelete, setConfirmDelete] = useState('')
  return (
    <Shell>
      <PageHeader title={project.name} />
      <ProjectNav slug={project.slug} />
      <div className="grid gap-5">
        <Card title="Link an app" description="Its Sentry SDK sends here once it has this DSN.">
          <div className="mb-5 grid min-w-0 gap-2">
            <Label>DSN</Label>
            <Code text={dsn} />
          </div>
          <Linking platform={platform} dsn={dsn} origin={origin} id={project.id} publicKey={project.public_key} />
        </Card>

        <Card
          title="Readable stacks"
          description="Upload debug files and source maps, and crashes show functions, files and lines."
        >
          <Uploads
            slug={project.slug}
            platform={platform}
            origin={origin}
            tokens={tokens}
            uploads={uploads}
            now={now}
          />
        </Card>

        <Card title="Project">
          <form
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={async (e) => {
              e.preventDefault()
              const f = new FormData(e.currentTarget)
              try {
                await updateProject({
                  data: {
                    id: project.id,
                    name: f.get('name'),
                    platform,
                    daily_event_quota: f.get('quota'),
                    event_retention_days: f.get('retention'),
                    daily_log_quota: f.get('logQuota'),
                    log_retention_days: f.get('logRetention'),
                  },
                })
                toast.success('Saved')
                await router.invalidate()
              } catch (error) {
                toast.error(error instanceof Error ? error.message : 'Not saved')
              }
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
            </div>
            <div className="grid gap-2">
              <Label htmlFor="quota">Events a day</Label>
              <Input
                id="quota"
                name="quota"
                type="number"
                min={0}
                inputMode="numeric"
                defaultValue={project.daily_event_quota}
              />
              <p className="text-xs text-muted-foreground">Past it, SDKs are told to wait until tomorrow (UTC).</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="retention">Keep events for (days)</Label>
              <Input
                id="retention"
                name="retention"
                type="number"
                min={1}
                inputMode="numeric"
                defaultValue={project.event_retention_days}
              />
              <p className="text-xs text-muted-foreground">Issues and their counts stay after their events go.</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="logQuota">Logs a day</Label>
              <Input
                id="logQuota"
                name="logQuota"
                type="number"
                min={0}
                inputMode="numeric"
                defaultValue={project.daily_log_quota}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="logRetention">Keep logs for (days)</Label>
              <Input
                id="logRetention"
                name="logRetention"
                type="number"
                min={1}
                inputMode="numeric"
                defaultValue={project.log_retention_days}
              />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit">Save</Button>
            </div>
          </form>
        </Card>

        <Card title="Key" description="A new key stops apps with the old DSN from being heard, within a minute.">
          <Button
            variant="outline"
            onClick={async () => {
              if (!confirm('Make a new key? Every app has to be updated with the new DSN.')) return
              await rotateKey({ data: { id: project.id } })
              toast.success('New key made')
              await router.invalidate()
            }}
          >
            Make a new key
          </Button>
        </Card>

        <Card title="Delete the project" description="Its issues and events go too. This can’t be undone.">
          <div className="flex flex-wrap gap-2">
            <Input
              className="max-w-xs"
              value={confirmDelete}
              onChange={(e) => setConfirmDelete(e.target.value)}
              placeholder={`Type ${project.slug} to confirm`}
              aria-label="Project to delete"
            />
            <Button
              variant="destructive"
              disabled={confirmDelete !== project.slug}
              onClick={async () => {
                await deleteProject({ data: { id: project.id } })
                toast.success(`${project.name} deleted`)
                await navigate({ to: '/' })
              }}
            >
              Delete
            </Button>
          </div>
        </Card>
      </div>
    </Shell>
  )
}
