import { ClientOnly, createFileRoute, useRouter } from '@tanstack/react-router'
import {
  IconBrandDiscord,
  IconBrandSlack,
  IconBrandTelegram,
  IconMail,
  IconPencil,
  IconPlus,
  IconSearch,
  IconBellRinging,
  IconTrash,
  IconWebhook,
} from '@tabler/icons-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Empty, PageHeader, Shell } from '@/components/shell'
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
  testChannel,
  testRoute,
} from '@/fns'
import { cn } from '@/lib/utils'
import { type Channel, telegramToken } from '@/notify/channels'
import { KINDS, LEVELS, type Route as NotifyRoute } from '@/notify/notice'

export const Route = createFileRoute('/notifications')({
  loader: () => getNotifications(),
  head: () => ({ meta: [{ title: 'Notifications · crashyard' }] }),
  component: Notifications,
})

type Data = Awaited<ReturnType<typeof getNotifications>>
const ICONS = {
  telegram: IconBrandTelegram,
  slack: IconBrandSlack,
  discord: IconBrandDiscord,
  email: IconMail,
  webhook: IconWebhook,
}
const list = <T,>(json: string | null): T[] => (json ? (JSON.parse(json) as T[]) : [])

function Notifications() {
  const d = Route.useLoaderData()
  const [channel, setChannel] = useState<Channel | 'new' | null>(null)
  const [route, setRoute] = useState<NotifyRoute | 'new' | null>(null)
  return (
    <Shell crumbs={['Notifications']}>
      <PageHeader title="Notifications">
        Channels are where alerts are delivered. Routes decide which alerts go to which channels.
      </PageHeader>

      <section className="mb-8">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">Channels</h2>
          <Button size="sm" variant="outline" onClick={() => setChannel('new')}>
            <IconPlus data-icon="inline-start" />
            Add a channel
          </Button>
        </div>
        {d.channels.length === 0 ? (
          <Empty compact icon={IconBellRinging} title="No channels yet">
            Nobody hears about a crash until you add one. A Telegram bot takes about a minute to set up.
          </Empty>
        ) : (
          <ul className="divide-y rounded-xl border">
            {d.channels.map((c) => {
              const Icon = ICONS[choiceOf(c)]
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
                  <TestButton label={`Send a test to ${c.name}`} send={() => testChannel({ data: { id: c.id } })} />
                  <Button size="icon-sm" variant="ghost" aria-label={`Edit ${c.name}`} onClick={() => setChannel(c)}>
                    <IconPencil />
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
            <IconPlus data-icon="inline-start" />
            Add a route
          </Button>
        </div>
        {d.routes.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            {d.channels.length ? 'No routes yet, so no alerts are sent.' : 'Add a channel first, then a route to it.'}
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
  if (config.format === 'slack') return 'Slack'
  if (config.format === 'discord') return 'Discord'
  return `JSON webhook · ${new URL(config.url).host}`
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

/** A list in prose: a, b and c */
const and = (items: string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

function RouteRow({ route: r, d, onEdit }: { route: NotifyRoute; d: Data; onEdit: () => void }) {
  const project =
    r.project_id === null
      ? 'Every project'
      : (d.projects.find((p) => p.id === r.project_id)?.name ?? 'A deleted project')
  const thresholds = list<number>(r.thresholds)
  const kinds = list<string>(r.kinds).map((k) =>
    k === 'threshold' && thresholds.length
      ? `${thresholds.length > 1 ? 'Thresholds' : 'Threshold'} of ${and(thresholds.map(String))} events`
      : (KINDS.find((x) => x.kind === k)?.label ?? k),
  )
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
          {' · '}
          {envs.length ? and(envs) : 'all environments'}
          {levels.length > 0 && ` · ${levels.join(', ')}`}
        </p>
      </div>
      <TestButton label="Send a test" send={() => testRoute({ data: { id: r.id } })} />
      <Button size="icon-sm" variant="ghost" aria-label="Edit route" onClick={onEdit}>
        <IconPencil />
      </Button>
    </li>
  )
}

/** Sends a made-up notice now, and says how each channel took it */
function TestButton({
  label,
  send,
}: {
  label: string
  send: () => Promise<({ channel: string; ok: true } | { channel: string; ok: false; error: string })[]>
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        const results = await send().finally(() => setBusy(false))
        for (const x of results) {
          if (x.ok) toast.success(`Sent to ${x.channel}`)
          else toast.error(`${x.channel}: ${x.error}`)
        }
        if (!results.length) toast.error('There’s no channel to send to')
      }}
    >
      <IconBellRinging />
    </Button>
  )
}

/** What the kind menu offers: Slack and Discord are webhooks in their formats */
type Choice = 'telegram' | 'slack' | 'discord' | 'email' | 'webhook'
function choiceOf(c?: Channel): Choice {
  if (!c) return 'telegram'
  const format = c.kind === 'webhook' ? (JSON.parse(c.config) as { format?: string }).format : undefined
  return format === 'slack' || format === 'discord' ? format : c.kind
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
  const [choice, setChoice] = useState<Choice>(choiceOf(channel))
  const kind: Channel['kind'] = choice === 'slack' || choice === 'discord' ? 'webhook' : choice
  const blocked = choice === 'email' && !emailReady
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
            const token = kind === 'telegram' ? telegramToken(f.token) : null
            if (kind === 'telegram' && !token)
              return toast.error('That isn’t a bot token. Copy the token from @BotFather, it looks like 123456789:AA…')
            if (kind === 'telegram' && !f.chat.trim())
              return toast.error('Choose a chat first. Send your bot a message, then select Find.')
            const settings =
              kind === 'telegram'
                ? { token, chat: f.chat.trim(), name: f.chatName || undefined }
                : kind === 'email'
                  ? { to: f.to }
                  : { url: f.url.trim(), format: choice === 'webhook' ? 'json' : choice }
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
              toast.error(error instanceof Error ? error.message : 'Couldn’t save. Try again.')
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{channel ? 'Edit channel' : 'Add a channel'}</DialogTitle>
            <DialogDescription>
              Channels are shared by every project. Routes choose what reaches them.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="channel-kind">Kind</Label>
              <Select value={choice} onValueChange={(v) => setChoice(v as Choice)}>
                <SelectTrigger id="channel-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="telegram">Telegram</SelectItem>
                  <SelectItem value="slack">Slack</SelectItem>
                  <SelectItem value="discord">Discord</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="webhook">Webhook (JSON)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {blocked ? (
              <EmailSetup />
            ) : (
              <Field id="name" label="Name" defaultValue={channel?.name} placeholder="My phone" required />
            )}
            {choice === 'telegram' && <TelegramFields config={config} />}
            {choice === 'slack' && (
              <Field
                id="url"
                label="Webhook URL"
                type="url"
                defaultValue={config.url}
                required
                pattern="https://hooks\.slack\.com/.+"
                placeholder="https://hooks.slack.com/services/…"
                hint="In Slack, go to api.slack.com/apps and create an app from scratch. Turn on Incoming Webhooks, add a webhook for the channel and copy its URL."
              />
            )}
            {choice === 'discord' && (
              <Field
                id="url"
                label="Webhook URL"
                type="url"
                defaultValue={config.url}
                required
                pattern="https://(discord|discordapp)\.com/api/webhooks/.+"
                placeholder="https://discord.com/api/webhooks/…"
                hint="In Discord, open the channel’s settings, then Integrations, Webhooks and New Webhook. Copy the webhook URL."
              />
            )}
            {choice === 'email' && !blocked && (
              <Field
                id="to"
                label="To"
                type="email"
                defaultValue={config.to}
                required
                hint="The address must be a verified destination in Cloudflare Email Routing."
              />
            )}
            {choice === 'webhook' && (
              <Field
                id="url"
                label="URL"
                type="url"
                defaultValue={config.url}
                required
                hint="Each alert is sent as a JSON POST with its kind, project, issue, event and URL."
              />
            )}
            <div className={cn('grid gap-2', blocked && 'hidden')}>
              <Label className="flex items-center gap-2 font-normal">
                <Checkbox checked={quiet} onCheckedChange={(c) => setQuiet(c === true)} />
                Quiet hours. Alerts are held, then sent together when they end.
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
                  if (!confirm(`Delete ${channel.name}? Routes will stop sending to it.`)) return
                  await deleteChannel({ data: { id: channel.id } })
                  await done()
                }}
              >
                <IconTrash data-icon="inline-start" />
                Delete
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={blocked}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Email can't be sent until the deployment has it: what to do, in place of the fields */
function EmailSetup() {
  return (
    <div className="grid gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <p className="font-medium">Email isn’t set up on this crashyard, so it can’t send any yet.</p>
      <ol className="ml-4 list-decimal text-muted-foreground">
        <li>In Cloudflare, open your domain’s Email Routing and turn it on.</li>
        <li>Add the address to notify as a destination, and confirm the email Cloudflare sends to it.</li>
        <li>
          Set <code className="font-mono text-xs">EMAIL_FROM</code> (an address on the domain, it needn’t exist) in the
          worker’s variables, and deploy again.
        </li>
      </ol>
      <p className="text-muted-foreground">docs/deploying.md, “Email notifications”, has the details.</p>
    </div>
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
      if (!chats.length) return toast.error('The bot has no messages yet. Send it one in Telegram, then try again.')
      setFound(chats)
      setChat(chats[0])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Telegram didn’t respond. Try again in a moment.')
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
        placeholder="123456789:AA…"
        hint="In Telegram, send /newbot to @BotFather. Paste the token it replies with, or the whole reply. Then send your new bot any message."
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
              name="chat"
              value={chat.id}
              onChange={(e) => setChat({ id: e.target.value, name: '' })}
              inputMode="numeric"
              autoComplete="off"
              placeholder="Write to the bot, then Find"
            />
          )}
          <Button type="button" variant="outline" disabled={!token.trim()} onClick={find}>
            <IconSearch data-icon="inline-start" />
            Find
          </Button>
        </div>
        {found.length > 1 && <input type="hidden" name="chat" value={chat.id} />}
        <input type="hidden" name="chatName" value={chat.name} />
        <p className="text-xs text-muted-foreground">
          {chat.name
            ? `Writes to ${chat.name}.`
            : 'Find picks the chat from the bot’s latest message. You can also type a chat ID.'}
        </p>
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
  hint,
  options,
  value,
  onChange,
}: {
  legend: string
  hint?: string
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
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
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
            if (!kinds.length || !channels.length) return toast.error('Choose at least one alert and one channel')
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
              toast.error(error instanceof Error ? error.message : 'Couldn’t save. Try again.')
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{route ? 'Edit route' : 'Add a route'}</DialogTitle>
            <DialogDescription>
              Choose which alerts go to which channels. A channel gets each alert once, whatever the route.
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
              legend="Alerts"
              options={KINDS.map((k) => ({ value: k.kind, label: k.label }))}
              value={kinds}
              onChange={setKinds}
            />
            {kinds.includes('threshold') && (
              <Field
                id="thresholds"
                label="Thresholds"
                defaultValue={route ? list<number>(route.thresholds).join(', ') : '10, 100, 1000'}
                hint="Alert when an issue reaches these event counts. Separate them with commas."
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
              hint="Separate them with commas. Leave empty for all environments."
            />
            <Checks
              legend="Levels"
              hint="Leave all unchecked to include every level."
              options={LEVELS.map((l) => ({ value: l, label: l[0].toUpperCase() + l.slice(1) }))}
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
                  if (!confirm('Delete this route? Its alerts will no longer be sent.')) return
                  await deleteRoute({ data: { id: route.id } })
                  await done()
                }}
              >
                <IconTrash data-icon="inline-start" />
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
