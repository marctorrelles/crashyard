import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router'
import { IconExternalLink } from '@tabler/icons-react'
import { useState } from 'react'
import { Markdown } from '@/components/markdown'
import { Hint, SaveButton, SettingsCard, useSave } from '@/components/settings'
import { PageHeader, Shell } from '@/components/shell'
import { Time } from '@/components/time'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { type Impact, IMPACTS, parseBranding, type PostState, STATES_FOR, stateLabel } from '@/data/status'
import {
  addStatusUpdate,
  createStatusPost,
  deleteStatusPage,
  deleteStatusPost,
  getStatusPosts,
  setStatusPageCheck,
  updateStatusPage,
} from '@/fns'

export const Route = createFileRoute('/status-pages/$slug')({
  loader: async ({ params }) => {
    const data = await getStatusPosts({ data: { slug: params.slug } })
    if (!data) throw notFound()
    return data
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.page.name ?? 'Status page'} · Status pages · crashyard` }],
  }),
  component: StatusPage,
})

type Loaded = NonNullable<Awaited<ReturnType<typeof getStatusPosts>>>
type Post = Loaded['posts'][number]
type Check = Loaded['checks'][number]

const PHASES = { open: 'Open', upcoming: 'Scheduled', ongoing: 'In progress', past: 'Ended' } as const

function StatusPage() {
  const { page } = Route.useLoaderData()
  return (
    <Shell crumbs={[<Link to="/status-pages">Status pages</Link>, page.name]}>
      <PageHeader
        title={page.name}
        actions={
          <Button variant="outline" asChild>
            <a href={`/status/${page.slug}`}>
              <IconExternalLink data-icon="inline-start" />
              Open status page
            </a>
          </Button>
        }
      >
        {page.domain ?? `/status/${page.slug}`}
      </PageHeader>
      <div className="@container">
        <StatusPageSettings />
      </div>
    </Shell>
  )
}

// The status page's checks, what to post on it, and what was posted: incidents, notices and maintenance
function StatusPageSettings() {
  const { page, checks, posts } = Route.useLoaderData()
  const { save } = useSave()
  const current = posts.filter((p) => p.phase !== 'past')
  const past = posts.filter((p) => p.phase === 'past')
  // Only the checks on the page can be named as affected
  const shown = checks.filter((c) => c.shown === 1)
  const projects = [...new Set(checks.map((c) => c.project))]
  return (
    <div className="grid gap-4">
      <SettingsCard
        title="Checks on the page"
        description="A public page anyone with the link can open, with the checks you choose and what you post. It shows a check’s name, whether it’s up and its incidents, never its address. With checks from more than one project, each project’s name heads its checks."
      >
        {checks.length ? (
          <div className="grid gap-5 @xl:grid-cols-2">
            {projects.map((project) => (
              <fieldset key={project} className="grid content-start gap-3">
                <legend className="mb-3 text-xs font-medium text-muted-foreground">{project}</legend>
                {checks
                  .filter((c) => c.project === project)
                  .map((c) => (
                    <div key={c.id} className="flex items-center gap-3 max-sm:min-h-10">
                      <Switch
                        id={`check-${c.id}`}
                        checked={c.shown === 1}
                        onCheckedChange={(on) =>
                          save(
                            () => setStatusPageCheck({ data: { page: page.id, monitor: c.id, on } }),
                            on ? 'Shown on the status page' : 'Taken off the status page',
                          )
                        }
                      />
                      <Label htmlFor={`check-${c.id}`}>{c.name}</Label>
                    </div>
                  ))}
              </fieldset>
            ))}
          </div>
        ) : (
          <Hint>No uptime checks yet. Add one under Monitors to show it here.</Hint>
        )}
      </SettingsCard>
      <NewPost page={page.id} checks={shown} />
      {current.length > 0 && (
        <SettingsCard title="Now on the page">
          <Posts posts={current} checks={checks} />
        </SettingsCard>
      )}
      {past.length > 0 && (
        <SettingsCard title="Ended in the last 30 days">
          <Posts posts={past} checks={checks} />
        </SettingsCard>
      )}
      <Branding />
      <Delete />
    </div>
  )
}

/** A time typed in the viewer's own zone, as milliseconds */
const fromLocal = (v: FormDataEntryValue | null) => (v ? new Date(String(v)).getTime() : null)

/** The checks on the page a post affects, as checkboxes named `monitors` */
function Affects({ id, checks, chosen = [] }: { id: string; checks: Check[]; chosen?: number[] }) {
  if (!checks.length) return null
  return (
    <fieldset className="grid gap-2 @xl:col-span-2">
      <legend className="mb-2 text-sm font-medium">Affects</legend>
      <div className="flex flex-wrap gap-x-5 gap-y-3">
        {checks.map((c) => (
          <div key={c.id} className="flex items-center gap-2 max-sm:min-h-10">
            <Checkbox
              id={`${id}-${c.id}`}
              name="monitors"
              value={String(c.id)}
              defaultChecked={chosen.includes(c.id)}
            />
            <Label htmlFor={`${id}-${c.id}`} className="font-normal">
              {c.name}
            </Label>
          </div>
        ))}
      </div>
      <Hint>These checks show as affected on the page while it’s open.</Hint>
    </fieldset>
  )
}

const chosenChecks = (f: FormData) => f.getAll('monitors').map(Number)

function NewPost({ page, checks }: { page: number; checks: Check[] }) {
  const { save, saving } = useSave()
  const [impact, setImpact] = useState<Impact>('minor')
  const [state, setState] = useState<PostState>('investigating')
  const [key, setKey] = useState(0)
  const pick = (i: Impact) => {
    setImpact(i)
    setState(STATES_FOR[i][0])
  }
  return (
    <SettingsCard
      title="Post to the status page"
      description="Tell people about an incident, a notice or planned maintenance. Add updates to it as things change."
    >
      <form
        key={key}
        className="grid gap-4 @xl:grid-cols-2"
        onSubmit={async (e) => {
          e.preventDefault()
          const f = new FormData(e.currentTarget)
          const posted = await save(
            () =>
              createStatusPost({
                data: {
                  page,
                  impact,
                  state,
                  title: f.get('title'),
                  message: f.get('message'),
                  starts: fromLocal(f.get('starts')),
                  ends: fromLocal(f.get('ends')),
                  monitors: chosenChecks(f),
                },
              }),
            'Posted',
          )
          if (posted) {
            setKey(key + 1)
            pick('minor')
          }
        }}
      >
        <div className="grid gap-2">
          <Label htmlFor="impact">Kind</Label>
          <Select value={impact} onValueChange={(v) => pick(v as Impact)}>
            <SelectTrigger id="impact" className="w-full max-sm:h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(IMPACTS) as Impact[]).map((i) => (
                <SelectItem key={i} value={i}>
                  {IMPACTS[i]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <StateSelect id="state" impact={impact} value={state} onChange={setState} />
        <div className="grid gap-2 @xl:col-span-2">
          <Label htmlFor="title">Title</Label>
          <Input
            id="title"
            name="title"
            required
            maxLength={120}
            placeholder={impact === 'maintenance' ? 'Database upgrade' : 'Checkouts are slow'}
            className="max-sm:h-10"
          />
        </div>
        {impact === 'maintenance' && (
          <>
            <div className="grid gap-2">
              <Label htmlFor="starts">Starts</Label>
              <Input id="starts" name="starts" type="datetime-local" required className="max-sm:h-10" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ends">Ends</Label>
              <Input id="ends" name="ends" type="datetime-local" required className="max-sm:h-10" />
            </div>
          </>
        )}
        {impact !== 'notice' && <Affects id="affects" checks={checks} />}
        <Message id="message" />
        <div>
          <SaveButton saving={saving}>Post</SaveButton>
        </div>
      </form>
    </SettingsCard>
  )
}

function StateSelect({
  id,
  impact,
  value,
  onChange,
}: {
  id: string
  impact: Impact
  value: PostState
  onChange: (s: PostState) => void
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>State</Label>
      <Select value={value} onValueChange={(v) => onChange(v as PostState)}>
        <SelectTrigger id={id} className="w-full max-sm:h-10">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATES_FOR[impact].map((s) => (
            <SelectItem key={s} value={s}>
              {stateLabel(s, impact)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function Message({ id }: { id: string }) {
  return (
    <div className="grid gap-2 @xl:col-span-2">
      <Label htmlFor={id}>Message</Label>
      <Textarea id={id} name="message" required maxLength={5000} rows={3} />
      <Hint>Shown as written. **Bold**, [links](https://example.com) and lists of - work.</Hint>
    </div>
  )
}

function Posts({ posts, checks }: { posts: Post[]; checks: Check[] }) {
  return (
    <ul className="grid gap-px overflow-hidden rounded-lg border bg-border">
      {posts.map((p) => (
        <PostItem key={p.id} post={p} checks={checks} />
      ))}
    </ul>
  )
}

function PostItem({ post, checks }: { post: Post; checks: Check[] }) {
  const { save, saving } = useSave()
  const [updating, setUpdating] = useState(false)
  const [state, setState] = useState<PostState>(post.updates[0]?.state ?? STATES_FOR[post.impact][0])
  return (
    <li className="grid gap-3 bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 font-medium">{post.title}</span>
        <Badge variant="outline">{IMPACTS[post.impact]}</Badge>
        <Badge variant="secondary">{PHASES[post.phase]}</Badge>
      </div>
      {post.starts !== null && post.ends !== null && (
        <p className="text-sm text-muted-foreground">
          <Time at={post.starts} /> to <Time at={post.ends} />
        </p>
      )}
      {post.affects.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Affects{' '}
          {checks
            .filter((c) => post.affects.includes(c.id))
            .map((c) => c.name)
            .join(', ')}
        </p>
      )}
      <ol className="grid gap-3">
        {post.updates.map((u, i) => (
          <li key={i} className="grid gap-1 border-l-2 pl-3">
            <p className="text-sm">
              <span className="font-medium">{stateLabel(u.state, post.impact)}</span>
              <span className="text-muted-foreground">
                {' '}
                · <Time at={u.at} /> · {u.by}
              </span>
            </p>
            <Markdown text={u.message} />
          </li>
        ))}
      </ol>
      {updating ? (
        <form
          className="grid gap-4 @xl:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault()
            const f = new FormData(e.currentTarget)
            const monitors = post.impact === 'notice' ? undefined : chosenChecks(f)
            const data = { id: post.id, state, message: f.get('message'), monitors }
            if (await save(() => addStatusUpdate({ data }), 'Update posted')) setUpdating(false)
          }}
        >
          <StateSelect id={`state-${post.id}`} impact={post.impact} value={state} onChange={setState} />
          {post.impact !== 'notice' && (
            <Affects
              id={`affects-${post.id}`}
              checks={checks.filter((c) => c.shown === 1 || post.affects.includes(c.id))}
              chosen={post.affects}
            />
          )}
          <Message id={`message-${post.id}`} />
          <div className="flex gap-2">
            <SaveButton saving={saving}>Post update</SaveButton>
            <Button type="button" variant="ghost" className="max-sm:h-10" onClick={() => setUpdating(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="max-sm:h-10" onClick={() => setUpdating(true)}>
            Add update
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive max-sm:h-10"
            onClick={() =>
              confirm(`Delete “${post.title}” and its updates? It leaves the status page, and this can’t be undone.`) &&
              save(() => deleteStatusPost({ data: { id: post.id } }), 'Deleted')
            }
          >
            Delete
          </Button>
        </div>
      )}
    </li>
  )
}

// The page's name and own look and address
function Branding() {
  const { page } = Route.useLoaderData()
  const navigate = useNavigate()
  const { save, saving } = useSave()
  const b = parseBranding(page.branding)
  const [color, setColor] = useState(b.color ?? '')
  return (
    <SettingsCard
      title="Look and address"
      description="Make the page yours. Everything but the name and address is optional."
    >
      <form
        className="grid gap-4 @xl:grid-cols-2"
        onSubmit={async (e) => {
          e.preventDefault()
          const f = new FormData(e.currentTarget)
          const slug = String(f.get('slug')).trim()
          const saved = await save(() =>
            updateStatusPage({
              data: {
                id: page.id,
                name: f.get('name'),
                slug,
                branding: {
                  title: f.get('page-title'),
                  description: f.get('description'),
                  logo: f.get('logo'),
                  color,
                  website: f.get('website'),
                },
                domain: f.get('domain'),
              },
            }),
          )
          if (saved && slug !== page.slug)
            await navigate({ to: '/status-pages/$slug', params: { slug }, replace: true })
        }}
      >
        <div className="grid content-start gap-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required maxLength={80} defaultValue={page.name} className="max-sm:h-10" />
        </div>
        <div className="grid content-start gap-2">
          <Label htmlFor="slug">Address</Label>
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 text-sm text-muted-foreground">/status/</span>
            <Input
              id="slug"
              name="slug"
              required
              maxLength={40}
              defaultValue={page.slug}
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono max-sm:h-10"
            />
          </div>
          <Hint>A new address breaks links to the old one.</Hint>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="page-title">Page title</Label>
          <Input
            id="page-title"
            name="page-title"
            maxLength={80}
            defaultValue={b.title}
            placeholder={`${page.name} status`}
            className="max-sm:h-10"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="color">Brand color</Label>
          <div className="flex gap-2">
            <input
              type="color"
              aria-label="Pick the brand color"
              value={color || '#000000'}
              onChange={(e) => setColor(e.target.value)}
              className="h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-transparent p-1 max-sm:h-10"
            />
            <Input
              id="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              maxLength={7}
              placeholder="#f97316"
              className="font-mono max-sm:h-10"
            />
          </div>
        </div>
        <div className="grid gap-2 @xl:col-span-2">
          <Label htmlFor="description">Description</Label>
          <Textarea
            id="description"
            name="description"
            maxLength={500}
            rows={2}
            defaultValue={b.description}
            placeholder="Live status of our apps and services."
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="logo">Logo address</Label>
          <Input
            id="logo"
            name="logo"
            type="url"
            maxLength={500}
            defaultValue={b.logo}
            placeholder="https://example.com/logo.svg"
            className="max-sm:h-10"
          />
          <Hint>A square image works best. It shows beside the title.</Hint>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="website">Website</Label>
          <Input
            id="website"
            name="website"
            type="url"
            maxLength={500}
            defaultValue={b.website}
            placeholder="https://example.com"
            className="max-sm:h-10"
          />
          <Hint>The page links back to it.</Hint>
        </div>
        <div className="grid gap-2 @xl:col-span-2">
          <Label htmlFor="domain">Custom domain</Label>
          <Input
            id="domain"
            name="domain"
            maxLength={253}
            defaultValue={page.domain ?? ''}
            placeholder="status.example.com"
            autoCapitalize="none"
            spellCheck={false}
            className="max-sm:h-10"
          />
          <Hint>
            First add it to crashyard’s Worker in Cloudflare, under Workers and Pages, crashyard, Settings, Domains and
            Routes, Add, Custom domain. Its domain must be on the same Cloudflare account. The address then opens this
            page and nothing else of crashyard.
            {page.domain && (
              <>
                {' '}
                <a href={`https://${page.domain}`} className="font-medium text-foreground underline underline-offset-2">
                  Open {page.domain}
                </a>
              </>
            )}
          </Hint>
        </div>
        <div>
          <SaveButton saving={saving} />
        </div>
      </form>
    </SettingsCard>
  )
}

function Delete() {
  const { page } = Route.useLoaderData()
  const navigate = useNavigate()
  const { save, saving } = useSave()
  return (
    <SettingsCard
      title="Delete status page"
      description="Its address stops working and its posts are deleted. The checks stay, with their history."
    >
      <div>
        <Button
          variant="destructive"
          disabled={saving}
          className="max-sm:h-10"
          onClick={async () => {
            if (!confirm(`Delete ${page.name} and all its posts? Its address stops working, and this can’t be undone.`))
              return
            if (await save(() => deleteStatusPage({ data: { id: page.id } }), 'Status page deleted'))
              await navigate({ to: '/status-pages' })
          }}
        >
          Delete status page
        </Button>
      </div>
    </SettingsCard>
  )
}
