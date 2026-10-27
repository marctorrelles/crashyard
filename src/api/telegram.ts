// POST /api/telegram/<bot id>: Telegram's webhook for a bot's buttons (src/notify/channels.ts), outside Access, so
// the secret Telegram sends back with every update is what lets it in. A tap acts on the issue as the channel's owner,
// answers with a toast and turns the buttons into what happened.
import { assignIssue, changeIssues } from '../data/issues'
import {
  botIdOf,
  CALLBACK,
  type Channel,
  type IssueAction,
  type TelegramConfig,
  telegramCall,
} from '../notify/channels'

type Update = {
  callback_query?: {
    id: string
    data?: string
    from: { first_name?: string; username?: string }
    message?: { message_id: number; chat: { id: number }; reply_markup?: { inline_keyboard: Button[][] } }
  }
}
type Button = { text: string; callback_data?: string; url?: string }

const ACTIONS = Object.fromEntries(Object.entries(CALLBACK).map(([a, c]) => [c, a])) as Record<string, IssueAction>
const DONE: Record<IssueAction, string> = {
  resolve: 'Resolved',
  ignore: 'Ignored until it escalates',
  assign: 'Assigned to you',
}

// Compared as digests, so the time taken says nothing about how much of a guess was right
async function same(a: string, b: string) {
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  const [x, y] = await Promise.all([digest(a), digest(b)])
  return x.every((v, i) => v === y[i])
}

export async function handleTelegram(request: Request, db: D1Database, botId: string, now = Date.now()) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const { results } = await db.prepare("SELECT * FROM channels WHERE kind = 'telegram'").all<Channel>()
  const channels = results
    .map((c) => ({ ...c, settings: JSON.parse(c.config) as TelegramConfig }))
    .filter((c) => botIdOf(c.settings.token) === botId && c.settings.secret)
  const secret = request.headers.get('x-telegram-bot-api-secret-token') ?? ''
  const checked = await Promise.all(channels.map(async (c) => ((await same(secret, c.settings.secret!)) ? c : null)))
  const known = checked.filter((c) => c !== null)
  if (!known.length) return new Response('Forbidden', { status: 403 })

  // From here Telegram is answered 200 whatever happens, or it sends the update again and again
  const update = (await request.json().catch(() => ({}))) as Update
  const tap = update.callback_query
  const message = tap?.message
  if (!tap || !message) return new Response('')
  // Only the chat a channel writes to acts through it
  const channel = known.find((c) => c.settings.chat === String(message.chat.id))
  // Every channel it found is of this bot, so any one's token answers; a failed answer only leaves the spinner
  const answer = (text?: string) =>
    telegramCall(known[0].settings, 'answerCallbackQuery', { callback_query_id: tap.id, text }).catch(() => {})
  const m = tap.data?.match(/^([a-z]):(\d+)$/)
  const action = m && ACTIONS[m[1]]
  if (!channel || !m || !action) {
    await answer()
    return new Response('')
  }
  const issueId = Number(m[2])
  const { owner } = channel.settings
  const by = owner ?? `${tap.from.username ? `@${tap.from.username}` : (tap.from.first_name ?? 'Someone')} on Telegram`
  try {
    const exists = await db.prepare('SELECT 1 FROM issues WHERE id = ?').bind(issueId).first()
    if (!exists) {
      await answer('That issue no longer exists')
      return new Response('')
    }
    if (action === 'resolve') await changeIssues(db, [issueId], { action: 'resolve' }, by, now)
    else if (action === 'ignore')
      await changeIssues(db, [issueId], { action: 'ignore', untilEscalating: true }, by, now)
    else if (owner) await assignIssue(db, issueId, owner, by, now)
    await answer(DONE[action])
    // The action's button becomes what happened; resolving or ignoring ends the issue's other actions
    const done = { text: `✓ ${DONE[action]}`, callback_data: 'done' }
    const rows = message.reply_markup?.inline_keyboard ?? []
    const keyboard = rows.map((row) =>
      row.some((b) => b.callback_data?.endsWith(`:${issueId}`))
        ? action === 'assign'
          ? row.map((b) => (b.callback_data === `${CALLBACK.assign}:${issueId}` ? done : b))
          : [done]
        : row,
    )
    await telegramCall(channel.settings, 'editMessageReplyMarkup', {
      chat_id: message.chat.id,
      message_id: message.message_id,
      reply_markup: { inline_keyboard: keyboard },
    }).catch(() => {})
  } catch (error) {
    console.error('telegram action', error)
    await answer('That didn’t work. Open the issue in crashyard instead.')
  }
  return new Response('')
}
