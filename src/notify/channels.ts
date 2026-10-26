// Sending a notice through a channel: Telegram, email (Cloudflare Email Routing) or a webhook.
import { type Notice, noticeLine } from './notice'

export type Channel = {
  id: number
  kind: 'telegram' | 'email' | 'webhook'
  name: string
  config: string // JSON
  quiet_from: number | null
  quiet_to: number | null
}

// A bot's token (from @BotFather), the chat it writes to and that chat's name; `server`, a local Bot API server
type TelegramConfig = { token: string; chat: string; name?: string; server?: string }
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

const TELEGRAM = 'https://api.telegram.org'
const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A message from the channel's bot: the title in bold, the line under it, and a button opening it in crashyard */
export function telegramRequest(config: TelegramConfig, notice: Notice): Request {
  return new Request(`${(config.server || TELEGRAM).replace(/\/$/, '')}/bot${config.token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.chat,
      text: `<b>${html(notice.issue.title.slice(0, 250))}</b>\n${html(noticeLine(notice))}`,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      // The week's summary arrives without a sound
      disable_notification: notice.kind === 'weekly',
      reply_markup: { inline_keyboard: [[{ text: 'Open in crashyard', url: notice.url }]] },
    }),
  })
}

type TelegramAnswer<T> = { ok: boolean; result?: T; description?: string }

/** A bot's token, `<bot id>:<secret>`, out of whatever was pasted: @BotFather's whole message, spaces, a URL */
export const telegramToken = (text: string) => text.match(/\d{5,}:[\w-]{20,}/)?.[0] ?? null

/** What Telegram's refusal means, and what to do about it */
export function telegramError(status: number, description = '') {
  if (status === 404) return 'Telegram has no bot with that token: copy it again from @BotFather (123456789:AA…)'
  if (status === 401)
    return 'Telegram refused the token: it may have been revoked, and /token in @BotFather gives a new one'
  if (status === 409) return 'The bot has a webhook, so its messages can’t be read here: type the chat id instead'
  if (/chat not found/i.test(description)) return 'Telegram can’t find that chat: write to the bot first, then find it'
  if (/blocked by the user/i.test(description)) return 'The bot is blocked: unblock it in Telegram'
  return `Telegram answered ${status}${description ? `: ${description}` : ''}`
}

/** Who wrote to the bot lately (Telegram keeps a day of updates): the chats it can write to, newest first */
export async function telegramChats(token: string): Promise<{ id: string; name: string }[]> {
  const response = await fetch(`${TELEGRAM}/bot${token}/getUpdates`)
  const answer = (await response.json().catch(() => ({ ok: false }))) as TelegramAnswer<
    { message?: { chat: { id: number; title?: string; first_name?: string; username?: string } } }[]
  >
  if (!answer.ok) throw new Error(telegramError(response.status, answer.description))
  const chats = new Map<string, string>()
  for (const u of (answer.result ?? []).toReversed()) {
    const chat = u.message?.chat
    if (chat && !chats.has(String(chat.id)))
      chats.set(String(chat.id), chat.title ?? chat.first_name ?? chat.username ?? String(chat.id))
  }
  return [...chats].map(([id, name]) => ({ id, name }))
}

const COLORS = { red: 0xdc2626, orange: 0xf97316, amber: 0xf59e0b, green: 0x16a34a, sky: 0x0ea5e9 }
const colorOf = (notice: Notice) =>
  notice.kind === 'monitor_up' || notice.kind === 'metric_resolved'
    ? COLORS.green
    : notice.kind === 'weekly'
      ? COLORS.sky
      : notice.kind === 'monitor_down' || notice.kind === 'metric_critical' || notice.issue.level === 'fatal'
        ? COLORS.red
        : notice.issue.level === 'error'
          ? COLORS.orange
          : COLORS.amber

/** Slack's mrkdwn and Discord's markdown take `&`, `<` and `>` as markup */
const slackText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function webhookBody(format: WebhookConfig['format'], notice: Notice): unknown {
  const title = notice.issue.title.slice(0, 250)
  const line = noticeLine(notice)
  // Slack: the title in bold over its line, and a button; `text` is what the notification itself shows
  if (format === 'slack')
    return {
      text: `${title}: ${line}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*${slackText(title)}*\n${slackText(line)}` } },
        {
          type: 'actions',
          elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in crashyard' }, url: notice.url }],
        },
      ],
    }
  // Discord: an embed coloured by what it is, its title linking to the page; no mention in a title pings anyone
  if (format === 'discord')
    return {
      embeds: [{ title, url: notice.url, description: line, color: colorOf(notice) }],
      allowed_mentions: { parse: [] },
    }
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
  if (channel.kind === 'telegram') {
    const response = await fetch(telegramRequest(config as TelegramConfig, notice))
    if (!response.ok) {
      const why = ((await response.json().catch(() => null)) as TelegramAnswer<unknown> | null)?.description
      throw new Error(telegramError(response.status, why))
    }
  } else if (channel.kind === 'webhook') {
    const { url, format } = config as WebhookConfig
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(webhookBody(format, notice)),
    })
    if (!response.ok) {
      const why = (await response.text().catch(() => '')).slice(0, 200)
      throw new Error(`The webhook returned HTTP ${response.status}${why ? `: ${why}` : ''}`)
    }
  } else if (channel.kind === 'email') {
    if (!mailer || !from) throw new Error('Email isn’t set up on this crashyard. Set EMAIL_FROM and deploy again.')
    const subject = `[crashyard] ${notice.issue.title}`.slice(0, 200)
    await mailer.send(
      from,
      (config as EmailConfig).to,
      subject,
      `${notice.issue.title}\n${noticeLine(notice)}\n\n${notice.url}\n`,
    )
  }
}
