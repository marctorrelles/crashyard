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

/** Who wrote to the bot lately (Telegram keeps a day of updates): the chats it can write to, newest first */
export async function telegramChats(token: string): Promise<{ id: string; name: string }[]> {
  const response = await fetch(`${TELEGRAM}/bot${token}/getUpdates`)
  const answer = (await response.json().catch(() => ({ ok: false }))) as TelegramAnswer<
    { message?: { chat: { id: number; title?: string; first_name?: string; username?: string } } }[]
  >
  if (!answer.ok)
    throw new Error(`Telegram answered ${response.status}${answer.description ? `: ${answer.description}` : ''}`)
  const chats = new Map<string, string>()
  for (const u of (answer.result ?? []).toReversed()) {
    const chat = u.message?.chat
    if (chat && !chats.has(String(chat.id)))
      chats.set(String(chat.id), chat.title ?? chat.first_name ?? chat.username ?? String(chat.id))
  }
  return [...chats].map(([id, name]) => ({ id, name }))
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
  if (channel.kind === 'telegram') {
    const response = await fetch(telegramRequest(config as TelegramConfig, notice))
    if (!response.ok) {
      const why = ((await response.json().catch(() => null)) as TelegramAnswer<unknown> | null)?.description
      throw new Error(`Telegram answered ${response.status}${why ? `: ${why}` : ''}`)
    }
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
