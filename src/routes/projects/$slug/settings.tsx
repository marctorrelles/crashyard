import { createFileRoute, notFound, useNavigate, useRouter, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { Code, Linking } from '@/components/linking'
import { PLATFORM_NAMES } from '@/components/new-project'
import { Uploads } from '@/components/uploads'
import { PageHeader, Shell } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createKey, deleteProject, getProjectSettings, updateProject } from '@/fns'

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
  const { project, dsn, publicKey, origin, tokens, uploads, now } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const [platform, setPlatform] = useState(project.platform)
  const [confirmDelete, setConfirmDelete] = useState('')
  return (
    <Shell
      crumbs={[
        <Link to="/">Overview</Link>,
        <Link to="/" search={{ project: project.slug }}>
          {project.name}
        </Link>,
        'Settings',
      ]}
    >
      <PageHeader title="Settings">{project.name}</PageHeader>
      <div className="grid gap-5">
        <Card
          title="Connect an app"
          description="Give the app’s Sentry SDK this DSN and its events start arriving here."
        >
          <div className="mb-5 grid min-w-0 gap-2">
            <Label>DSN</Label>
            <Code text={dsn} />
          </div>
          <Linking platform={platform} dsn={dsn} origin={origin} id={project.id} publicKey={publicKey} />
        </Card>

        <Card
          title="Symbols and source maps"
          description="Upload debug files and source maps so crashes show function names, files and line numbers."
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

        <Card
          title="Source code"
          description="Open stack frames at their line in the repository, and see each release’s commits."
        >
          <form
            className="grid gap-4"
            onSubmit={async (e) => {
              e.preventDefault()
              try {
                await updateProject({ data: { ...project, repo_url: new FormData(e.currentTarget).get('repo') } })
                toast.success('Saved')
                await router.invalidate()
              } catch (error) {
                toast.error(error instanceof Error ? error.message : 'Couldn’t save the repository')
              }
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
                <Button type="submit">Save</Button>
              </div>
            </div>
            <div className="grid min-w-0 gap-2">
              <p className="text-sm">
                Send each release’s commits from its checkout, using the release name the SDK reports. The first time,
                the full history is sent so crashyard can find every file.
              </p>
              <Code
                text={`sentry-cli releases new -p ${project.slug} "$RELEASE"\nsentry-cli releases set-commits "$RELEASE" --local --initial-depth 100000`}
              />
            </div>
          </form>
        </Card>

        <Card title="General">
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
                toast.error(error instanceof Error ? error.message : 'Couldn’t save the settings')
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
              <Label htmlFor="quota">Daily event limit</Label>
              <Input
                id="quota"
                name="quota"
                type="number"
                min={0}
                inputMode="numeric"
                defaultValue={project.daily_event_quota}
              />
              <p className="text-xs text-muted-foreground">
                Past this, SDKs are asked to hold events until midnight UTC.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="retention">Event retention in days</Label>
              <Input
                id="retention"
                name="retention"
                type="number"
                min={1}
                inputMode="numeric"
                defaultValue={project.event_retention_days}
              />
              <p className="text-xs text-muted-foreground">
                Issues and their counts are kept after their events are deleted.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="logQuota">Daily log limit</Label>
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
              <Label htmlFor="logRetention">Log retention in days</Label>
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

        <Card
          title="Client key"
          description="A new key replaces the DSN. Apps still using the old one stop reporting within a minute."
        >
          <Button
            variant="outline"
            onClick={async () => {
              await createKey({ data: { project: project.id, label: 'Untitled' } })
              toast.success('Key created')
              await router.invalidate()
            }}
          >
            Create new key
          </Button>
        </Card>

        <Card
          title="Delete project"
          description="Deletes the project with all its issues and events. This can’t be undone."
        >
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
