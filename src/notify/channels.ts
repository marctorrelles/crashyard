// Sending a notice through a channel: Telegram, email (Cloudflare Email Routing) or a webhook.
import { ISSUE_KINDS, type Notice, noticeLine } from './notice'

export type Channel = {
  id: number
  kind: 'telegram' | 'email' | 'webhook'
  name: string
  config: string // JSON
  quiet_from: number | null
  quiet_to: number | null
  quiet_zone: string | null // IANA; null: quiet hours in UTC, as rows before 0020
}

// A bot's token (from @BotFather), the chat it writes to and that chat's name; `server`, a local Bot API server.
// `secret`: the webhook's, set when saving registered it, so the bot's buttons act; `owner`: who saved it, "me" in
// Assign to me
export type TelegramConfig = {
  token: string
  chat: string
  name?: string
  server?: string
  secret?: string
  owner?: string
}
type EmailConfig = { to: string }
type WebhookConfig = { url: string; format?: 'json' | 'slack' | 'discord' }

export type Mailer = { send(from: string, to: string, subject: string, text: string): Promise<void> }

const clocks = new Map<string, Intl.DateTimeFormat>()
/** Minutes after midnight in a time zone, by `Intl`, so daylight saving is right; UTC for none or an unknown one */
function minuteIn(zone: string | null | undefined, at: number) {
  if (!zone) return Math.floor((at % 86_400_000) / 60_000)
  let clock = clocks.get(zone)
  if (!clock) {
    try {
      clock = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    } catch {
      return Math.floor((at % 86_400_000) / 60_000)
    }
    clocks.set(zone, clock)
  }
  const parts = clock.formatToParts(at)
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return part('hour') * 60 + part('minute')
}

/**
 * Whether a channel's quiet hours (minutes after midnight in `quiet_zone`, UTC without one, wrapping past midnight)
 * cover a moment
 */
export function isQuiet(
  channel: Pick<Channel, 'quiet_from' | 'quiet_to'> & { quiet_zone?: string | null },
  at: number,
): boolean {
  const { quiet_from: from, quiet_to: to } = channel
  if (from === null || to === null || from === to) return false
  const minute = minuteIn(channel.quiet_zone, at)
  return from < to ? minute >= from && minute < to : minute >= from || minute < to
}

const TELEGRAM = 'https://api.telegram.org'
const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** What a notice about an issue can do from where it arrives */
export type IssueAction = 'resolve' | 'ignore' | 'assign'
export const ACTION_LABELS: Record<IssueAction, string> = {
  resolve: 'Resolve',
  ignore: 'Ignore',
  assign: 'Assign to me',
}
const issueIdOf = (notice: Notice) => (ISSUE_KINDS.has(notice.kind) ? notice.issue.id : undefined)

/** The issue's page with an action ready to confirm, for whoever is signed in: links can't act on their own, as
 *  mail scanners and link previews open them */
export const actionUrl = (notice: Notice, action: IssueAction) => `${notice.url}?do=${action}`

/** A Telegram button's data, `r:12`, which the webhook reads back (src/api/telegram.ts); 64 bytes at most */
export const CALLBACK = { resolve: 'r', ignore: 'i', assign: 'a' } as const satisfies Record<IssueAction, string>

/** The buttons under an issue's message: its actions, acting in the chat once the webhook is set, then Open */
export function telegramKeyboard(config: TelegramConfig, notice: Notice) {
  const id = issueIdOf(notice)
  const actions = (['resolve', 'ignore', ...(config.owner ? ['assign' as const] : [])] as IssueAction[]).map((a) => ({
    text: ACTION_LABELS[a],
    callback_data: `${CALLBACK[a]}:${id}`,
  }))
  return [...(id !== undefined && config.secret ? [actions] : []), [{ text: 'Open in crashyard', url: notice.url }]]
}

/** A message from the channel's bot: the title in bold, the line under it, its actions and a button opening it */
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
      reply_markup: { inline_keyboard: telegramKeyboard(config, notice) },
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

/** One Bot API method; throws Telegram's refusal in words */
export async function telegramCall(config: Pick<TelegramConfig, 'token' | 'server'>, method: string, body: unknown) {
  const response = await fetch(`${(config.server || TELEGRAM).replace(/\/$/, '')}/bot${config.token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const answer = (await response.json().catch(() => ({ ok: false }))) as TelegramAnswer<unknown>
  if (!answer.ok) throw new Error(telegramError(response.status, answer.description))
  return answer.result
}

/** A bot's id, the part of its token before the colon: one webhook a bot, whichever of its channels set it */
export const botIdOf = (token: string) => token.split(':')[0]

/** Who wrote to the bot lately (Telegram keeps a day of updates): the chats it can write to, newest first. A bot
 *  whose buttons act has a webhook, which getUpdates refuses: it's taken off, and saving the channel sets it again */
export async function telegramChats(token: string): Promise<{ id: string; name: string }[]> {
  let response = await fetch(`${TELEGRAM}/bot${token}/getUpdates`)
  if (response.status === 409) {
    await telegramCall({ token }, 'deleteWebhook', {})
    response = await fetch(`${TELEGRAM}/bot${token}/getUpdates`)
  }
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

// The action links of a notice about an issue, none for the rest
const links = (notice: Notice): [IssueAction, string][] =>
  issueIdOf(notice) === undefined
    ? []
    : (['resolve', 'ignore', 'assign'] as const).map((a) => [a, actionUrl(notice, a)])

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
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Open in crashyard' }, url: notice.url },
            ...links(notice).map(([a, url]) => ({
              type: 'button',
              text: { type: 'plain_text', text: ACTION_LABELS[a] },
              url,
            })),
          ],
        },
      ],
    }
  // Discord: an embed coloured by what it is, its title linking to the page; no mention in a title pings anyone
  if (format === 'discord')
    return {
      embeds: [
        {
          title,
          url: notice.url,
          description: [
            line,
            links(notice)
              .map(([a, url]) => `[${ACTION_LABELS[a]}](${url})`)
              .join(' · '),
          ]
            .filter(Boolean)
            .join('\n'),
          color: colorOf(notice),
        },
      ],
      allowed_mentions: { parse: [] },
    }
  return {
    kind: notice.kind,
    threshold: notice.threshold,
    project: notice.project,
    issue: notice.issue,
    event: notice.event,
    url: notice.url,
    actions: links(notice).length ? Object.fromEntries(links(notice)) : undefined,
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
      [
        notice.issue.title,
        noticeLine(notice),
        '',
        notice.url,
        ...links(notice).map(([a, url]) => `${ACTION_LABELS[a]}: ${url}`),
        '',
      ].join('\n'),
    )
  }
}
