import { ClientOnly, createFileRoute, useRouter } from '@tanstack/react-router'
import {
  MailIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
  SearchIcon,
  SendHorizontalIcon,
  Trash2Icon,
  WebhookIcon,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { PageHeader, Shell } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  deleteChannel,
  deleteRoute,
  findTelegramChats,
  getNotifications,
  saveChannel,
  saveRoute,
  testRoute,
} from '@/fns'
import type { Channel } from '@/notify/channels'
import { KINDS, LEVELS, type Route as NotifyRoute } from '@/notify/notice'

export const Route = createFileRoute('/notifications')({
  loader: () => getNotifications(),
  head: () => ({ meta: [{ title: 'Notifications · crashyard' }] }),
  component: Notifications,
})

type Data = Awaited<ReturnType<typeof getNotifications>>
const ICONS = { telegram: SendHorizontalIcon, email: MailIcon, webhook: WebhookIcon }
const list = <T,>(json: string | null): T[] => (json ? (JSON.parse(json) as T[]) : [])

function Notifications() {
  const d = Route.useLoaderData()
  const [channel, setChannel] = useState<Channel | 'new' | null>(null)
  const [route, setRoute] = useState<NotifyRoute | 'new' | null>(null)
  return (
    <Shell crumbs={['Notifications']}>
      <PageHeader title="Notifications">Channels are where a notification goes; routes say which go where.</PageHeader>

      <section className="mb-8">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">Channels</h2>
          <Button size="sm" variant="outline" onClick={() => setChannel('new')}>
            <PlusIcon data-icon="inline-start" />
            Add a channel
          </Button>
        </div>
        {d.channels.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            None yet. A Telegram bot is the quickest: make one with @BotFather, write to it, add it here.
          </p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {d.channels.map((c) => {
              const Icon = ICONS[c.kind]
              return (
                <li key={c.id} className="flex items-center gap-3 px-4 py-3">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{c.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {summary(c)}
                      {c.quiet_from !== null && c.quiet_to !== null && (
                        // In the browser's time, which the server can't know
                        <ClientOnly>{` · quiet ${clock(c.quiet_from)}–${clock(c.quiet_to)}`}</ClientOnly>
                      )}
                    </p>
                  </div>
                  <Button size="icon-sm" variant="ghost" aria-label={`Edit ${c.name}`} onClick={() => setChannel(c)}>
                    <PencilIcon />
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">Routes</h2>
          <Button size="sm" variant="outline" disabled={!d.channels.length} onClick={() => setRoute('new')}>
            <PlusIcon data-icon="inline-start" />
            Add a route
          </Button>
        </div>
        {d.routes.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            {d.channels.length ? 'No routes: nothing is sent yet.' : 'Add a channel first.'}
          </p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {d.routes.map((r) => (
              <RouteRow key={r.id} route={r} d={d} onEdit={() => setRoute(r)} />
            ))}
          </ul>
        )}
      </section>

      {channel && (
        <ChannelDialog
          channel={channel === 'new' ? undefined : channel}
          emailReady={d.emailReady}
          onClose={() => setChannel(null)}
        />
      )}
      {route && <RouteDialog route={route === 'new' ? undefined : route} d={d} onClose={() => setRoute(null)} />}
    </Shell>
  )
}

function summary(c: Channel) {
  const config = JSON.parse(c.config) as Record<string, string>
  if (c.kind === 'telegram') return `Telegram · ${config.name ?? `chat ${config.chat}`}`
  if (c.kind === 'email') return `email · ${config.to}`
  return `${config.format ?? 'json'} webhook · ${new URL(config.url).host}`
}

// Quiet hours are kept in UTC; they're shown and set in the browser's time
// ponytail: today's offset, so a daylight-saving change moves them an hour; store a time zone if that matters
const offset = () => new Date().getTimezoneOffset()
const toLocal = (utc: number) => (((utc - offset()) % 1440) + 1440) % 1440
const toUtc = (local: number) => (((local + offset()) % 1440) + 1440) % 1440
const clock = (utc: number) => {
  const m = toLocal(utc)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
const minutesOf = (value: string) => {
  const [h, m] = value.split(':').map(Number)
  return h * 60 + m
}

function RouteRow({ route: r, d, onEdit }: { route: NotifyRoute; d: Data; onEdit: () => void }) {
  const [busy, setBusy] = useState(false)
  const project =
    r.project_id === null
      ? 'Every project'
      : (d.projects.find((p) => p.id === r.project_id)?.name ?? 'A deleted project')
  const kinds = list<string>(r.kinds).map((k) => KINDS.find((x) => x.kind === k)?.label ?? k)
  const channels = list<number>(r.channel_ids)
    .map((id) => d.channels.find((c) => c.id === id)?.name)
    .filter(Boolean)
  const envs = list<string>(r.environments)
  const levels = list<string>(r.levels)
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {project} → {channels.join(', ') || 'no channel'}
        </p>
        <p className="text-xs text-muted-foreground">
          {kinds.join(', ')}
          {list<string>(r.kinds).includes('threshold') && ` at ${list<number>(r.thresholds).join(', ')}`}
          {' · '}
          {envs.length ? envs.join(', ') : 'every environment'}
          {levels.length > 0 && ` · ${levels.join(', ')}`}
        </p>
      </div>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Send a test"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          const results = await testRoute({ data: { id: r.id } })
          setBusy(false)
          for (const x of results) {
            if (x.ok) toast.success(`Sent to ${x.channel}`)
            else toast.error(`${x.channel}: ${x.error}`)
          }
          if (!results.length) toast.error('The route has no channels')
        }}
      >
        <SendIcon />
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="Edit route" onClick={onEdit}>
        <PencilIcon />
      </Button>
    </li>
  )
}

function ChannelDialog({
  channel,
  emailReady,
  onClose,
}: {
  channel?: Channel
  emailReady: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const config = channel ? (JSON.parse(channel.config) as Record<string, string>) : {}
  const [kind, setKind] = useState<Channel['kind']>(channel?.kind ?? 'telegram')
  const [format, setFormat] = useState(config.format ?? 'json')
  const [quiet, setQuiet] = useState(channel?.quiet_from != null)
  const done = async () => {
    onClose()
    await router.invalidate()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={async (e) => {
            e.preventDefault()
            const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>
            if (kind === 'telegram' && !f.chat) return toast.error('Find the chat first: write to the bot, then Find')
            const settings =
              kind === 'telegram'
                ? { token: f.token.trim(), chat: f.chat.trim(), name: f.chatName || undefined }
                : kind === 'email'
                  ? { to: f.to }
                  : { url: f.url, format }
            try {
              await saveChannel({
                data: {
                  id: channel?.id,
                  kind,
                  name: f.name,
                  config: JSON.stringify(settings),
                  quiet_from: quiet && f.quiet_from ? toUtc(minutesOf(f.quiet_from)) : null,
                  quiet_to: quiet && f.quiet_to ? toUtc(minutesOf(f.quiet_to)) : null,
                },
              })
              await done()
            } catch (error) {
              toast.error(error instanceof Error ? error.message : 'Not saved')
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{channel ? 'Edit channel' : 'Add a channel'}</DialogTitle>
            <DialogDescription>Shared by every project; routes pick which go here.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="channel-kind">Kind</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as Channel['kind'])}>
                <SelectTrigger id="channel-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="telegram">Telegram bot</SelectItem>
                  <SelectItem value="email">Email (Cloudflare Email Routing)</SelectItem>
                  <SelectItem value="webhook">Webhook (JSON, Slack, Discord)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Field id="name" label="Name" defaultValue={channel?.name} placeholder="My phone" required />
            {kind === 'telegram' && <TelegramFields config={config} />}
            {kind === 'email' && (
              <Field
                id="to"
                label="To"
                type="email"
                defaultValue={config.to}
                required
                hint={
                  emailReady
                    ? 'It must be a verified destination in Email Routing.'
                    : 'Email isn’t set up yet: see “Email notifications” in docs/deploying.md.'
                }
              />
            )}
            {kind === 'webhook' && (
              <>
                <Field id="url" label="URL" type="url" defaultValue={config.url} required />
                <div className="grid gap-2">
                  <Label htmlFor="channel-format">Format</Label>
                  <Select value={format} onValueChange={setFormat}>
                    <SelectTrigger id="channel-format" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="json">JSON</SelectItem>
                      <SelectItem value="slack">Slack</SelectItem>
                      <SelectItem value="discord">Discord</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
            <div className="grid gap-2">
              <Label className="flex items-center gap-2 font-normal">
                <Checkbox checked={quiet} onCheckedChange={(c) => setQuiet(c === true)} />
                Quiet hours: hold notifications, send them as one after
              </Label>
              {quiet && (
                <div className="flex items-center gap-2">
                  <Input
                    name="quiet_from"
                    type="time"
                    required
                    aria-label="Quiet from"
                    defaultValue={channel?.quiet_from != null ? clock(channel.quiet_from) : '22:00'}
                  />
                  <span className="text-sm text-muted-foreground">to</span>
                  <Input
                    name="quiet_to"
                    type="time"
                    required
                    aria-label="Quiet until"
                    defaultValue={channel?.quiet_to != null ? clock(channel.quiet_to) : '08:00'}
                  />
                </div>
              )}
            </div>
          </div>
          <DialogFooter className="sm:justify-between">
            {channel ? (
              <Button
                type="button"
                variant="destructive"
                onClick={async () => {
                  if (!confirm(`Delete ${channel.name}? Routes stop sending to it.`)) return
                  await deleteChannel({ data: { id: channel.id } })
                  await done()
                }}
              >
                <Trash2Icon data-icon="inline-start" />
                Delete
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** A bot's token and the chat it writes to, found from the bot's latest messages */
function TelegramFields({ config }: { config: Record<string, string> }) {
  const [token, setToken] = useState(config.token ?? '')
  const [chat, setChat] = useState({ id: config.chat ?? '', name: config.name ?? '' })
  const [found, setFound] = useState<{ id: string; name: string }[]>([])
  const find = async () => {
    try {
      const chats = await findTelegramChats({ data: { token } })
      if (!chats.length) return toast.error('No messages yet: write to your bot in Telegram, then find again.')
      setFound(chats)
      setChat(chats[0])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Telegram didn’t answer')
    }
  }
  return (
    <>
      <Field
        id="token"
        label="Bot token"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        required
        hint="In Telegram, @BotFather’s /newbot gives a bot and its token. Then write anything to your bot."
      />
      <div className="grid gap-2">
        <Label htmlFor="f-chat">Chat</Label>
        <div className="flex gap-2">
          {found.length > 1 ? (
            <Select value={chat.id} onValueChange={(id) => setChat(found.find((c) => c.id === id)!)}>
              <SelectTrigger id="f-chat" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {found.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              id="f-chat"
              value={chat.name ? `${chat.name} (${chat.id})` : chat.id}
              readOnly
              required
              placeholder="Write to the bot, then find it"
            />
          )}
          <Button type="button" variant="outline" disabled={!token.trim()} onClick={find}>
            <SearchIcon data-icon="inline-start" />
            Find
          </Button>
        </div>
        <input type="hidden" name="chat" value={chat.id} />
        <input type="hidden" name="chatName" value={chat.name} />
      </div>
    </>
  )
}

function Field({
  id,
  label,
  hint,
  ...props
}: { id: string; label: string; hint?: string } & React.ComponentProps<'input'>) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={`f-${id}`}>{label}</Label>
      <Input id={`f-${id}`} name={id} autoComplete="off" {...props} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Checks<T extends string | number>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string
  options: { value: T; label: string }[]
  value: T[]
  onChange: (v: T[]) => void
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {options.map((o) => (
          <Label key={o.value} className="flex items-center gap-2 font-normal">
            <Checkbox
              checked={value.includes(o.value)}
              onCheckedChange={(c) => onChange(c === true ? [...value, o.value] : value.filter((v) => v !== o.value))}
            />
            {o.label}
          </Label>
        ))}
      </div>
    </fieldset>
  )
}

function RouteDialog({ route, d, onClose }: { route?: NotifyRoute; d: Data; onClose: () => void }) {
  const router = useRouter()
  const [project, setProject] = useState(route?.project_id != null ? String(route.project_id) : '*')
  const [kinds, setKinds] = useState<string[]>(
    route
      ? list(route.kinds)
      : ['new', 'regression', 'threshold', 'review_crash', 'monitor_down', 'monitor_up', 'slower_release', 'weekly'],
  )
  const [levels, setLevels] = useState<string[]>(route ? list(route.levels) : [])
  const [channels, setChannels] = useState<number[]>(
    route ? list(route.channel_ids) : d.channels.slice(0, 1).map((c) => c.id),
  )
  const done = async () => {
    onClose()
    await router.invalidate()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <form
          className="contents"
          onSubmit={async (e) => {
            e.preventDefault()
            const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>
            const envs = f.environments
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
            const thresholds = f.thresholds
              .split(',')
              .map((s) => Number(s.trim()))
              .filter((n) => Number.isInteger(n) && n > 0)
            if (!kinds.length || !channels.length) return toast.error('Pick at least one kind and one channel')
            try {
              await saveRoute({
                data: {
                  id: route?.id,
                  project_id: project === '*' ? null : Number(project),
                  kinds: JSON.stringify(kinds),
                  levels: levels.length ? JSON.stringify(levels) : null,
                  environments: envs.length ? JSON.stringify(envs) : null,
                  thresholds: JSON.stringify(thresholds.sort((a, b) => a - b)),
                  channel_ids: JSON.stringify(channels),
                },
              })
              await done()
            } catch (error) {
              toast.error(error instanceof Error ? error.message : 'Not saved')
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{route ? 'Edit route' : 'Add a route'}</DialogTitle>
            <DialogDescription>
              Which notifications go to which channels. A channel hears of each once.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-5">
            <div className="grid gap-2">
              <Label htmlFor="route-project">Project</Label>
              <Select value={project} onValueChange={setProject}>
                <SelectTrigger id="route-project" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="*">Every project</SelectItem>
                  {d.projects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Checks
              legend="When"
              options={KINDS.map((k) => ({ value: k.kind, label: k.label }))}
              value={kinds}
              onChange={setKinds}
            />
            {kinds.includes('threshold') && (
              <Field
                id="thresholds"
                label="Thresholds"
                defaultValue={route ? list<number>(route.thresholds).join(', ') : '10, 100, 1000'}
                hint="Events in one issue, comma-separated."
              />
            )}
            {!kinds.includes('threshold') && (
              <input
                type="hidden"
                name="thresholds"
                value={route ? list<number>(route.thresholds).join(',') : '10,100,1000'}
              />
            )}
            <Field
              id="environments"
              label="Environments"
              defaultValue={route ? list<string>(route.environments).join(', ') : 'production'}
              hint="Comma-separated; empty for every one."
            />
            <Checks
              legend="Levels (none checked: every level)"
              options={LEVELS.map((l) => ({ value: l, label: l }))}
              value={levels}
              onChange={setLevels}
            />
            <Checks
              legend="Send to"
              options={d.channels.map((c) => ({ value: c.id, label: c.name }))}
              value={channels}
              onChange={setChannels}
            />
          </div>
          <DialogFooter className="sm:justify-between">
            {route ? (
              <Button
                type="button"
                variant="destructive"
                onClick={async () => {
                  if (!confirm('Delete this route?')) return
                  await deleteRoute({ data: { id: route.id } })
                  await done()
                }}
              >
                <Trash2Icon data-icon="inline-start" />
                Delete
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
