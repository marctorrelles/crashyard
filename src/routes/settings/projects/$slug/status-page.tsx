import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { useState } from 'react'
import { Markdown } from '@/components/markdown'
import { Hint, SaveButton, SettingsCard, useSave } from '@/components/settings'
import { Time } from '@/components/time'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { type Impact, IMPACTS, type PostState, STATES_FOR, stateLabel } from '@/data/status'
import { addStatusUpdate, createStatusPost, deleteStatusPost, getStatusPosts, setMonitorPublic } from '@/fns'

export const Route = createFileRoute('/settings/projects/$slug/status-page')({
  loader: ({ params }) => getStatusPosts({ data: { slug: params.slug } }),
  component: StatusPageSettings,
})

const parent = getRouteApi('/settings/projects/$slug')

type Post = Awaited<ReturnType<typeof getStatusPosts>>['posts'][number]

const PHASES = { open: 'Open', upcoming: 'Scheduled', ongoing: 'In progress', past: 'Ended' } as const

// The status page's checks, what to post on it, and what was posted: incidents, notices and maintenance
function StatusPageSettings() {
  const { project } = parent.useLoaderData()
  const { checks, posts } = Route.useLoaderData()
  const { save } = useSave()
  const current = posts.filter((p) => p.phase !== 'past')
  const past = posts.filter((p) => p.phase === 'past')
  return (
    <div className="grid gap-4">
      <SettingsCard
        title="Status page"
        description={
          <>
            A public page anyone with the link can open, with the checks you choose and what you post. It shows a
            check’s name, whether it’s up and its incidents, never its address.{' '}
            <a href={`/status/${project.slug}`} className="font-medium text-foreground underline underline-offset-2">
              Open the status page
            </a>
          </>
        }
      >
        {checks.length ? (
          <div className="grid gap-3">
            {checks.map((c) => (
              <div key={c.id} className="flex items-center gap-3">
                <Switch
                  id={`check-${c.id}`}
                  checked={c.public === 1}
                  onCheckedChange={(on) =>
                    save(
                      () => setMonitorPublic({ data: { id: c.id, on } }),
                      on ? 'Shown on the status page' : 'Taken off the status page',
                    )
                  }
                />
                <Label htmlFor={`check-${c.id}`}>{c.name}</Label>
              </div>
            ))}
          </div>
        ) : (
          <Hint>No uptime checks yet. Add one under Monitors to show it here.</Hint>
        )}
      </SettingsCard>
      <NewPost slug={project.slug} />
      {current.length > 0 && (
        <SettingsCard title="Now on the page">
          <Posts posts={current} />
        </SettingsCard>
      )}
      {past.length > 0 && (
        <SettingsCard title="Ended in the last 30 days">
          <Posts posts={past} />
        </SettingsCard>
      )}
    </div>
  )
}

/** A time typed in the viewer's own zone, as milliseconds */
const fromLocal = (v: FormDataEntryValue | null) => (v ? new Date(String(v)).getTime() : null)

function NewPost({ slug }: { slug: string }) {
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
                  slug,
                  impact,
                  state,
                  title: f.get('title'),
                  message: f.get('message'),
                  starts: fromLocal(f.get('starts')),
                  ends: fromLocal(f.get('ends')),
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

function Posts({ posts }: { posts: Post[] }) {
  return (
    <ul className="grid gap-px overflow-hidden rounded-lg border bg-border">
      {posts.map((p) => (
        <PostItem key={p.id} post={p} />
      ))}
    </ul>
  )
}

function PostItem({ post }: { post: Post }) {
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
            const message = new FormData(e.currentTarget).get('message')
            if (await save(() => addStatusUpdate({ data: { id: post.id, state, message } }), 'Update posted'))
              setUpdating(false)
          }}
        >
          <StateSelect id={`state-${post.id}`} impact={post.impact} value={state} onChange={setState} />
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
