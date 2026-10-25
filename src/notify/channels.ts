// Sending a notice through a channel: ntfy, email (Cloudflare Email Routing) or a webhook.
import { type Notice, noticeLine } from './notice'

export type Channel = {
  id: number
  kind: 'ntfy' | 'email' | 'webhook'
  name: string
  config: string // JSON
  quiet_from: number | null
  quiet_to: number | null
}

type NtfyConfig = { server?: string; topic: string; token?: string }
type EmailConfig = { to: string }
type WebhookConfig = { url: string; format?: 'json' | 'slack' | 'discord' }

export type Mailer = { send(from: string, to: string, subject: string, text: string): Promise<void> }

/** Whether a channel's quiet hours (minutes after midnight UTC, wrapping past midnight) cover a moment */
export function isQuiet(channel: Pick<Channel, 'quiet_from' | 'quiet_to'>, at: number): boolean {
  const { quiet_from: from, quiet_to: to } = channel
  if (from === null || to === null || from === to) return false
  const minute = Math.floor((at % 86_400_000) / 60_000)
  return from < to ? minute >= from && minute < to : minute >= from || minute < to
}

export function ntfyRequest(config: NtfyConfig, notice: Notice): Request {
  const headers: Record<string, string> = {
    Title: notice.issue.title.slice(0, 250),
    Click: notice.url,
    Tags:
      notice.kind === 'monitor_down'
        ? 'rotating_light'
        : notice.kind === 'monitor_up'
          ? 'white_check_mark'
          : notice.kind === 'regression'
            ? 'repeat'
            : notice.issue.level === 'fatal'
              ? 'boom'
              : 'warning',
    Priority: ['new', 'regression', 'review_crash', 'monitor_down'].includes(notice.kind) ? 'high' : 'default',
  }
  if (notice.actions) {
    headers.Actions = `http, Resolve, ${notice.actions.resolve}, method=POST, clear=true; http, Ignore, ${notice.actions.ignore}, method=POST, clear=true`
  }
  if (config.token) headers.Authorization = `Bearer ${config.token}`
  const server = (config.server || 'https://ntfy.sh').replace(/\/$/, '')
  return new Request(`${server}/${encodeURIComponent(config.topic)}`, {
    method: 'POST',
    headers,
    body: noticeLine(notice),
  })
}

export function webhookBody(format: WebhookConfig['format'], notice: Notice): unknown {
  const text = `${notice.issue.title}\n${noticeLine(notice)}\n${notice.url}`
  if (format === 'slack') return { text }
  if (format === 'discord') return { content: text }
  return {
    kind: notice.kind,
    threshold: notice.threshold,
    project: notice.project,
    issue: notice.issue,
    event: notice.event,
    url: notice.url,
  }
}

export async function send(channel: Channel, notice: Notice, mailer?: Mailer, from?: string): Promise<void> {
  const config = JSON.parse(channel.config)
  if (channel.kind === 'ntfy') {
    const response = await fetch(ntfyRequest(config as NtfyConfig, notice))
    if (!response.ok) throw new Error(`ntfy answered ${response.status}`)
  } else if (channel.kind === 'webhook') {
    const { url, format } = config as WebhookConfig
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(webhookBody(format, notice)),
    })
    if (!response.ok) throw new Error(`the webhook answered ${response.status}`)
  } else if (channel.kind === 'email') {
    if (!mailer || !from) throw new Error('email isn’t set up: the EMAIL binding and EMAIL_FROM')
    const subject = `[crashyard] ${notice.issue.title}`.slice(0, 200)
    await mailer.send(
      from,
      (config as EmailConfig).to,
      subject,
      `${notice.issue.title}\n${noticeLine(notice)}\n\n${notice.url}\n`,
    )
  }
}
